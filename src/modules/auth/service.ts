import { and, eq, gt, isNull, or } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "../../db/client.js";
import { accountTokens, accounts, sessions } from "../../db/schema/index.js";
import type { Env } from "../../config/env.js";
import { errors } from "../../lib/errors.js";
import type { Mailer } from "../../lib/mailer.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./passwords.js";
import {
  type AccessClaims,
  type Role,
  generateAccountToken,
  generateRefreshToken,
  hashAccountToken,
  hashRefreshToken,
  signAccessToken,
} from "./tokens.js";

export interface TokenResponse {
  did: string;
  handle: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AccountView {
  did: string;
  handle: string;
  email: string;
  /** When the address was confirmed through the emailed link; null until then. */
  emailVerifiedAt: string | null;
  displayName: string;
  description: string;
  avatarURL: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Contract `RegisterResponse`: the new profile plus its first token pair. */
export interface RegisterResponse extends TokenResponse {
  email: string;
  displayName: string;
  avatarURL: string | null;
  createdAt: string;
}

type AccountTokenKind = (typeof accountTokens.$inferSelect)["kind"];

/** Lifetimes of the single-use emailed tokens (spec §4.7: short-lived). */
export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

type AccountRow = typeof accounts.$inferSelect;

/** The pool handle or a transaction handle — both expose the query builders. */
type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function toAccountView(a: AccountRow): AccountView {
  return {
    did: a.did,
    handle: a.handle,
    email: a.email,
    emailVerifiedAt: a.emailVerifiedAt?.toISOString() ?? null,
    displayName: a.displayName,
    description: a.description,
    avatarURL: a.avatarUrl,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly env: Env,
    private readonly mailer: Mailer | null = null,
  ) {}

  private refreshExpired(issuedAt: Date): boolean {
    const ttlMs = this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
    return issuedAt.getTime() + ttlMs < Date.now();
  }

  /**
   * Creates an account. v1: reached only from the operator seed CLI — the
   * public register endpoint is closed (spec §3).
   */
  async createAccount(input: {
    handle: string;
    email: string;
    password: string;
    displayName: string;
    role: Role;
  }): Promise<AccountRow> {
    const id = uuidv7();
    const passwordHash = await hashPassword(input.password);
    try {
      const [row] = await this.db
        .insert(accounts)
        .values({
          id,
          did: `did:tplace:${id}`,
          handle: input.handle,
          email: input.email,
          displayName: input.displayName,
          passwordHash,
          role: input.role,
        })
        .returning();
      return row!;
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === "23505") {
        throw errors.conflict("handle_taken", "Handle or email is already in use");
      }
      throw err;
    }
  }

  /**
   * Verifies credentials and opens a new session chain.
   *
   * Always reports the resolved `accountId` when the identifier matched a real
   * account — even on failure — so the caller can rate-limit against a stable
   * key rather than the submitted string (spec §2.4 counts failures per
   * ACCOUNT; keying on the raw identifier would give handle and email separate
   * budgets, doubling the allowance). The caller must not leak this to clients.
   *
   * Argon2 always runs (dummy hash when the account is missing) so response
   * timing does not reveal account existence either.
   */
  async login(
    identifier: string,
    password: string,
    deviceInfo: string | null,
  ): Promise<{ accountId: string | null; tokens: TokenResponse | null }> {
    const [account] = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          or(eq(accounts.handle, identifier), eq(accounts.email, identifier)),
          isNull(accounts.deletedAt),
        ),
      )
      .limit(1);

    const ok = await verifyPassword(account?.passwordHash ?? DUMMY_HASH, password);
    if (!account || !ok) return { accountId: account?.id ?? null, tokens: null };

    return { accountId: account.id, tokens: await this.openSession(account, deviceInfo) };
  }

  /** Opens a new session chain for an account and returns its first token pair. */
  private async openSession(account: AccountRow, deviceInfo: string | null): Promise<TokenResponse> {
    const chainId = uuidv7();
    const refreshToken = generateRefreshToken();
    await this.db.insert(sessions).values({
      accountId: account.id,
      refreshHash: hashRefreshToken(refreshToken),
      chainId,
      deviceInfo,
    });
    return this.tokenResponse(account, chainId, refreshToken);
  }

  /**
   * Public registration (spec §4.1, open when REGISTRATION_OPEN=true). Creates
   * a `user` account, signs it in, and emails the verification link. A failed
   * send does not fail the registration: the account exists and can ask for
   * the email again from the verify-request endpoint.
   */
  async register(
    input: { handle: string; email: string; password: string; displayName: string },
    deviceInfo: string | null,
  ): Promise<RegisterResponse> {
    const account = await this.createAccount({ ...input, role: "user" });
    const tokens = await this.openSession(account, deviceInfo);
    await this.requestEmailVerification(account.id).catch(() => undefined);
    return {
      ...tokens,
      email: account.email,
      displayName: account.displayName,
      avatarURL: account.avatarUrl,
      createdAt: account.createdAt.toISOString(),
    };
  }

  // ---- Emailed single-use tokens (spec §4.7) ----

  /**
   * Issues a fresh token of `kind` and retires every unconsumed one of the
   * same kind, so only the latest email is live. Returns the raw token, which
   * exists only in the email: the table holds its hash.
   */
  private async issueAccountToken(accountId: string, kind: AccountTokenKind, ttlMs: number): Promise<string> {
    const raw = generateAccountToken();
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(accountTokens)
        .set({ consumedAt: now })
        .where(
          and(
            eq(accountTokens.accountId, accountId),
            eq(accountTokens.kind, kind),
            isNull(accountTokens.consumedAt),
          ),
        );
      await tx.insert(accountTokens).values({
        accountId,
        kind,
        tokenHash: hashAccountToken(raw),
        expiresAt: new Date(now.getTime() + ttlMs),
      });
    });
    return raw;
  }

  /**
   * Consumes a token atomically: the UPDATE only matches a live row, so two
   * concurrent presentations of one token yield exactly one winner.
   */
  private async consumeAccountToken(tx: DbOrTx, raw: string, kind: AccountTokenKind): Promise<string> {
    const [row] = await tx
      .update(accountTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(accountTokens.tokenHash, hashAccountToken(raw)),
          eq(accountTokens.kind, kind),
          isNull(accountTokens.consumedAt),
          gt(accountTokens.expiresAt, new Date()),
        ),
      )
      .returning({ accountId: accountTokens.accountId });
    if (!row) throw errors.invalidToken();
    return row.accountId;
  }

  private accountLink(path: string, token: string): string {
    const base = this.env.ACCOUNT_LINKS_BASE_URL ?? "http://127.0.0.1:5173";
    return `${base}${path}?token=${encodeURIComponent(token)}`;
  }

  /** Emails a verification link; a no-op for an already verified address. */
  async requestEmailVerification(accountId: string): Promise<void> {
    const [a] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
      .limit(1);
    if (!a) throw errors.unauthenticated();
    if (a.emailVerifiedAt || !this.mailer) return;
    const token = await this.issueAccountToken(a.id, "email_verify", EMAIL_VERIFY_TTL_MS);
    await this.mailer.send({
      to: a.email,
      subject: "Confirm your email address",
      text: [
        `Hi ${a.displayName},`,
        "",
        "Confirm this address for your Third Place account by opening the link below.",
        "It is valid for 24 hours.",
        "",
        this.accountLink("/account/verify-email", token),
        "",
        "If you did not create an account, ignore this message.",
      ].join("\n"),
    });
  }

  async verifyEmail(raw: string): Promise<{ verified: boolean }> {
    await this.db.transaction(async (tx) => {
      const accountId = await this.consumeAccountToken(tx, raw, "email_verify");
      await tx
        .update(accounts)
        .set({ emailVerifiedAt: new Date() })
        .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)));
    });
    return { verified: true };
  }

  /**
   * Emails a reset link when the identifier names an account. The caller
   * answers 202 either way (no account oracle, spec §4.7).
   */
  async requestPasswordReset(identifier: string): Promise<void> {
    if (!this.mailer) return;
    const [a] = await this.db
      .select()
      .from(accounts)
      .where(
        and(
          or(eq(accounts.handle, identifier), eq(accounts.email, identifier)),
          isNull(accounts.deletedAt),
        ),
      )
      .limit(1);
    if (!a) return;
    const token = await this.issueAccountToken(a.id, "password_reset", PASSWORD_RESET_TTL_MS);
    await this.mailer.send({
      to: a.email,
      subject: "Reset your password",
      text: [
        `Hi ${a.displayName},`,
        "",
        "Someone asked to reset the password of your Third Place account.",
        "Open the link below within 30 minutes to choose a new one.",
        "",
        this.accountLink("/account/reset-password", token),
        "",
        "If this was not you, ignore this message; your password is unchanged.",
      ].join("\n"),
    });
  }

  /** Sets a new password and invalidates every session (spec §4.7). */
  async resetPassword(raw: string, password: string): Promise<{ reset: boolean }> {
    const passwordHash = await hashPassword(password);
    await this.db.transaction(async (tx) => {
      const accountId = await this.consumeAccountToken(tx, raw, "password_reset");
      await tx.update(accounts).set({ passwordHash }).where(eq(accounts.id, accountId));
      await this.revokeAllSessions(tx, accountId);
    });
    return { reset: true };
  }

  private async tokenResponse(
    account: AccountRow,
    chainId: string,
    refreshToken: string,
  ): Promise<TokenResponse> {
    const claims: AccessClaims = {
      sub: account.id,
      did: account.did,
      handle: account.handle,
      role: account.role,
      chain: chainId,
    };
    return {
      did: account.did,
      handle: account.handle,
      accessToken: await signAccessToken(this.env, claims),
      refreshToken,
      expiresIn: this.env.ACCESS_TOKEN_TTL_SEC,
    };
  }

  /**
   * Refresh rotation (spec §4): each rotation inserts a new session row in the
   * same chain and revokes the old row. Presenting an already-revoked token is
   * reuse — the entire chain is invalidated.
   */
  async rotate(refreshToken: string): Promise<TokenResponse> {
    const hash = hashRefreshToken(refreshToken);

    // The failure branches MUST NOT throw inside the transaction: a throw
    // rolls the transaction back, which would undo the very revocations that
    // make reuse detection real. Return a marker, commit, then throw.
    type Outcome =
      | { kind: "invalid" }
      | { kind: "ok"; account: AccountRow; chainId: string; next: string };

    const outcome = await this.db.transaction(async (tx): Promise<Outcome> => {
      const [row] = await tx
        .select({ session: sessions, account: accounts })
        .from(sessions)
        .innerJoin(accounts, eq(sessions.accountId, accounts.id))
        .where(eq(sessions.refreshHash, hash))
        .limit(1);

      if (!row) return { kind: "invalid" };

      if (row.session.revokedAt) {
        // Reuse detected → kill the whole chain.
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.chainId, row.session.chainId), isNull(sessions.revokedAt)));
        return { kind: "invalid" };
      }

      if (this.refreshExpired(row.session.issuedAt) || row.account.deletedAt) {
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(eq(sessions.id, row.session.id));
        return { kind: "invalid" };
      }

      // Consume the presented token as a compare-and-swap BEFORE minting the
      // successor. Under READ COMMITTED two concurrent rotations of the same
      // token both observe revokedAt=null above; the loser's UPDATE matches
      // zero rows here, so exactly one rotation can succeed. Without this
      // guard both would commit, forking the chain and silently defeating
      // reuse detection.
      const consumed = await tx
        .update(sessions)
        .set({ revokedAt: new Date(), lastUsedAt: new Date() })
        .where(and(eq(sessions.id, row.session.id), isNull(sessions.revokedAt)))
        .returning({ id: sessions.id });

      if (consumed.length === 0) {
        // Another request consumed this exact token concurrently — same
        // signal as replaying a spent token: kill the chain.
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.chainId, row.session.chainId), isNull(sessions.revokedAt)));
        return { kind: "invalid" };
      }

      const next = generateRefreshToken();
      await tx.insert(sessions).values({
        accountId: row.account.id,
        refreshHash: hashRefreshToken(next),
        chainId: row.session.chainId,
        deviceInfo: row.session.deviceInfo,
      });

      return { kind: "ok", account: row.account, chainId: row.session.chainId, next };
    });

    if (outcome.kind !== "ok") throw errors.invalidToken();
    return this.tokenResponse(outcome.account, outcome.chainId, outcome.next);
  }

  /** Idempotent: revoking an unknown/already-revoked token still reports true (contract). */
  async logout(refreshToken: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.refreshHash, hashRefreshToken(refreshToken)), isNull(sessions.revokedAt)));
  }

  /** Active sessions = the live (non-revoked, non-expired) row of each chain. */
  async listSessions(accountId: string, currentChain: string) {
    const cutoff = new Date(Date.now() - this.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.accountId, accountId),
          isNull(sessions.revokedAt),
          gt(sessions.issuedAt, cutoff),
        ),
      );
    return rows
      .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime())
      .map((s) => ({
        sessionID: s.id,
        issuedAt: s.issuedAt.toISOString(),
        lastUsedAt: s.lastUsedAt.toISOString(),
        deviceInfo: s.deviceInfo,
        isCurrent: s.chainId === currentChain,
      }));
  }

  async revokeSession(accountId: string, sessionId: string): Promise<void> {
    const updated = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.id, sessionId),
          eq(sessions.accountId, accountId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning({ id: sessions.id });
    if (updated.length === 0) throw errors.notFound("Session not found");
  }

  /** Accepts either the pool handle or a transaction — callers needing
   *  atomicity (password change, account delete) pass the transaction. */
  private async revokeAllSessions(tx: DbOrTx, accountId: string): Promise<void> {
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.accountId, accountId), isNull(sessions.revokedAt)));
  }

  async getAccount(accountId: string): Promise<AccountView> {
    const [a] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
      .limit(1);
    if (!a) throw errors.unauthenticated();
    return toAccountView(a);
  }

  /**
   * Partial update (spec §4.6). Password change verifies `current` and then
   * invalidates ALL sessions (spec §4). Email change resets verification.
   *
   * Field semantics, uniform across every field: `null` and omission both mean
   * "leave untouched" (spec §7.2). Clearing a value is not expressible in v1 —
   * a dedicated mechanism arrives if the client ever needs it.
   */
  async updateAccount(
    accountId: string,
    input: {
      displayName?: string | null;
      description?: string | null;
      avatarURL?: string | null;
      email?: string | null;
      password?: { current: string; next: string };
    },
  ): Promise<AccountView> {
    const [a] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
      .limit(1);
    if (!a) throw errors.unauthenticated();

    const patch: Partial<typeof accounts.$inferInsert> = {};
    if (input.displayName != null) patch.displayName = input.displayName;
    if (input.description != null) patch.description = input.description;
    if (input.avatarURL != null) patch.avatarUrl = input.avatarURL;
    if (input.email != null && input.email !== a.email) {
      patch.email = input.email;
      patch.emailVerifiedAt = null;
    }
    if (input.password) {
      const ok = await verifyPassword(a.passwordHash, input.password.current);
      if (!ok) throw errors.unauthenticated("Current password is incorrect");
      patch.passwordHash = await hashPassword(input.password.next);
    }

    // A schema-valid body can leave nothing to write (e.g. `{}` or all-null).
    // drizzle throws on an empty SET clause, so return the account unchanged.
    if (Object.keys(patch).length === 0) return toAccountView(a);

    try {
      // One transaction: a password change must never commit without the
      // session revocation that makes stolen tokens useless.
      const updated = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(accounts)
          .set(patch)
          .where(eq(accounts.id, accountId))
          .returning();
        if (input.password) await this.revokeAllSessions(tx, accountId);
        return row!;
      });
      return toAccountView(updated);
    } catch (err) {
      if ((err as { cause?: { code?: string } }).cause?.code === "23505") {
        throw errors.conflict("email_taken", "Email is already in use");
      }
      throw err;
    }
  }

  /** Soft delete + revoke all sessions (spec §4.6). Password re-entry required. */
  async deleteAccount(
    accountId: string,
    password: string,
  ): Promise<{ did: string; deleted: boolean; deletedAt: string }> {
    const [a] = await this.db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), isNull(accounts.deletedAt)))
      .limit(1);
    if (!a) throw errors.unauthenticated();

    const ok = await verifyPassword(a.passwordHash, password);
    if (!ok) throw errors.unauthenticated("Password is incorrect");

    // Atomic: a soft-deleted account must never keep live sessions.
    const deletedAt = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(accounts).set({ deletedAt }).where(eq(accounts.id, accountId));
      await this.revokeAllSessions(tx, accountId);
    });
    return { did: a.did, deleted: true, deletedAt: deletedAt.toISOString() };
  }
}
