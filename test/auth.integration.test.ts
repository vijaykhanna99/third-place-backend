import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { AuthService } from "../src/modules/auth/service.js";

/**
 * Auth integration tests — require real Postgres (Redis optional; the login
 * limiter falls back to memory). Run via:
 *   TEST_DATABASE_URL=postgres://tplace:tplace@localhost:5433/tplace pnpm test
 * Assumes migrations applied.
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const KEY = "c".repeat(64);
const RUN = Date.now();
const HANDLE = `itest-auth-${RUN}`;
const EMAIL = `itest-auth-${RUN}@example.com`;
const EMAIL_OTHER = `itest-auth-other-${RUN}@example.com`;
const PASSWORD = "operator-password-1";

describe.runIf(Boolean(DB_URL))("auth integration", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp(
      loadEnvFrom({
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        DATABASE_URL: DB_URL!,
        JWT_SIGNING_KEY: KEY,
      }),
    );
    await app.pgSql!`DELETE FROM accounts WHERE handle LIKE 'itest-auth-%'`;
    // Seed an operator the way the CLI does.
    const service = new AuthService(app.db!, app.env);
    await service.createAccount({
      handle: HANDLE,
      email: EMAIL,
      password: PASSWORD,
      displayName: "Auth Itest",
      role: "operator",
    });
    // A second account so the email-conflict path has something to collide with.
    await service.createAccount({
      handle: `itest-auth-other-${RUN}`,
      email: EMAIL_OTHER,
      password: "other-account-pw-1",
      displayName: "Other",
      role: "operator",
    });

    // Role enforcement has no production route yet (operator-only endpoints
    // arrive in step 5) — register a probe so the 403 branch is covered now.
    app.get("/test/operator-only", { preHandler: app.requireRole("operator") }, () => ({
      ok: true,
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app.pgSql!`DELETE FROM accounts WHERE handle LIKE 'itest-auth-%'`;
    await app.close();
  });

  /**
   * Each caller gets its own remoteAddress so the shared per-IP budget
   * (20 failures / 15 min) can never make one test's failures spill into
   * another's. Failure-heavy tests pass an explicit distinct IP.
   */
  const login = (identifier = HANDLE, password = PASSWORD, ip = "10.0.0.1") =>
    app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier, password },
      remoteAddress: ip,
    });

  it("register endpoint is externally closed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { handle: "someone", email: "x@example.com", password: "aaaaaaaaaa", displayName: "X" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: { code: "registration_closed", message: "Registration is not open" },
    });
  });

  it("login works with handle and with email, returns token pair", async () => {
    for (const identifier of [HANDLE, EMAIL]) {
      const res = await login(identifier);
      expect(res.statusCode).toBe(200);
      const body = res.json<{ did: string; handle: string; accessToken: string; refreshToken: string; expiresIn: number }>();
      expect(body.handle).toBe(HANDLE);
      expect(body.did).toMatch(/^did:tplace:/);
      expect(body.refreshToken).toMatch(/^rft_/);
      expect(body.expiresIn).toBe(900);
    }
  });

  it("login failure is uniform for wrong password and unknown account", async () => {
    const wrongPw = await login(HANDLE, "wrong-password-x", "10.0.9.1");
    const unknown = await login(`no-such-${RUN}`, "wrong-password-x", "10.0.9.1");
    expect(wrongPw.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrongPw.json()).toEqual(unknown.json());
  });

  it("bearer token grants access; garbage token does not", async () => {
    const { accessToken } = login && (await login()).json<{ accessToken: string }>();
    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/account",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ handle: string }>().handle).toBe(HANDLE);

    const bad = await app.inject({
      method: "GET",
      url: "/api/v1/account",
      headers: { authorization: "Bearer garbage" },
    });
    expect(bad.statusCode).toBe(401);
  });

  it("refresh rotates the token and reuse kills the whole chain", async () => {
    const first = (await login()).json<{ accessToken: string; refreshToken: string }>();

    const rotated = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json<{ accessToken: string; refreshToken: string }>();
    expect(second.refreshToken).not.toBe(first.refreshToken);

    // Reuse of the consumed token → 401 and the chain dies.
    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: first.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);

    // The rotated (newest) token is dead too — whole chain invalidated.
    const afterKill = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: second.refreshToken },
    });
    expect(afterKill.statusCode).toBe(401);

    // And the chain's access token no longer passes the session check.
    const guarded = await app.inject({
      method: "GET",
      url: "/api/v1/account",
      headers: { authorization: `Bearer ${second.accessToken}` },
    });
    expect(guarded.statusCode).toBe(401);
  });

  it("logout revokes the session and is idempotent", async () => {
    const { refreshToken } = (await login()).json<{ refreshToken: string }>();
    const out1 = await app.inject({ method: "POST", url: "/api/v1/auth/logout", payload: { refreshToken } });
    expect(out1.json()).toEqual({ revoked: true });
    const out2 = await app.inject({ method: "POST", url: "/api/v1/auth/logout", payload: { refreshToken } });
    expect(out2.json()).toEqual({ revoked: true });
    const rotten = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken } });
    expect(rotten.statusCode).toBe(401);
  });

  it("lists sessions with isCurrent and revokes by id", async () => {
    const a = (await login()).json<{ accessToken: string }>();
    const b = (await login()).json<{ accessToken: string }>();

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    const { sessions } = list.json<{
      sessions: { sessionID: string; isCurrent: boolean }[];
    }>();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.filter((s) => s.isCurrent)).toHaveLength(1);

    const other = sessions.find((s) => !s.isCurrent)!;
    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/auth/sessions/${other.sessionID}/revoke`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(revoke.json()).toEqual({ revoked: true });

    // Revoking it again → 404.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/auth/sessions/${other.sessionID}/revoke`,
      headers: { authorization: `Bearer ${b.accessToken}` },
    });
    expect(again.statusCode).toBe(404);
    void a;
  });

  it("password change requires current password and revokes all sessions", async () => {
    const { accessToken } = (await login()).json<{ accessToken: string }>();

    const badCurrent = await app.inject({
      method: "POST",
      url: "/api/v1/account",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { password: { current: "totally-wrong-pw", next: "new-password-abc-1" } },
    });
    expect(badCurrent.statusCode).toBe(401);

    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/account",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { password: { current: PASSWORD, next: "new-password-abc-1" } },
    });
    expect(changed.statusCode).toBe(200);

    // All sessions revoked → same bearer now rejected by the session check.
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/account",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(after.statusCode).toBe(401);

    // Old password no longer works; new one does. Restore for later tests.
    expect((await login(HANDLE, PASSWORD)).statusCode).toBe(401);
    const relog = await login(HANDLE, "new-password-abc-1");
    expect(relog.statusCode).toBe(200);
    const tok = relog.json<{ accessToken: string }>().accessToken;
    await app.inject({
      method: "POST",
      url: "/api/v1/account",
      headers: { authorization: `Bearer ${tok}` },
      payload: { password: { current: "new-password-abc-1", next: PASSWORD } },
    });
  });

  it("dormant email/reset endpoints behave per contract", async () => {
    const req = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset-request",
      payload: { identifier: HANDLE },
    });
    expect(req.statusCode).toBe(202);

    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token: "anything", password: "aaaaaaaaaaaa" },
    });
    expect(reset.statusCode).toBe(401);
  });

  it("rate limits after 5 login failures for one account", async () => {
    const victim = `itest-auth-rl-${RUN}`;
    const service = new AuthService(app.db!, app.env);
    await service.createAccount({
      handle: victim,
      email: `${victim}@example.com`,
      password: "victim-password-1",
      displayName: "RL",
      role: "operator",
    });
    for (let i = 0; i < 5; i++) {
      const res = await login(victim, "wrong-password", "10.1.0.1");
      expect(res.statusCode).toBe(401);
    }
    // 6th attempt — even with the CORRECT password — is locked out.
    const locked = await login(victim, "victim-password-1", "10.1.0.1");
    expect(locked.statusCode).toBe(429);
    expect(locked.json<{ error: { code: string } }>().error.code).toBe("rate_limited");

    // The budget is per ACCOUNT, not per submitted string: the email spends
    // the same 5 attempts as the handle, and a different account is unaffected.
    const viaEmail = await login(`${victim}@example.com`, "victim-password-1", "10.1.0.2");
    expect(viaEmail.statusCode).toBe(429);
    expect((await login(HANDLE, PASSWORD, "10.1.0.3")).statusCode).toBe(200);
  });

  it("concurrent rotation of one refresh token yields exactly one winner", async () => {
    const { refreshToken } = (await login()).json<{ refreshToken: string }>();

    // Under READ COMMITTED a naive implementation lets several of these all
    // observe an unrevoked row and mint parallel successors, forking the
    // chain and defeating reuse detection entirely.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: "POST",
          url: "/api/v1/auth/refresh",
          payload: { refreshToken },
        }),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(7);

    // A losing racer is treated as reuse, so the chain is dead — including
    // the token the winner just minted.
    const winner = ok[0]!.json<{ refreshToken: string }>();
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: winner.refreshToken },
    });
    expect(after.statusCode).toBe(401);
  });

  it("enforces operator role on role-gated routes", async () => {
    const plain = `itest-auth-user-${RUN}`;
    const service = new AuthService(app.db!, app.env);
    await service.createAccount({
      handle: plain,
      email: `${plain}@example.com`,
      password: "plain-user-pw-12",
      displayName: "Plain",
      role: "user",
    });

    const opToken = (await login()).json<{ accessToken: string }>().accessToken;
    const userToken = (await login(plain, "plain-user-pw-12")).json<{ accessToken: string }>()
      .accessToken;

    const asOperator = await app.inject({
      method: "GET",
      url: "/test/operator-only",
      headers: { authorization: `Bearer ${opToken}` },
    });
    expect(asOperator.statusCode).toBe(200);

    const asUser = await app.inject({
      method: "GET",
      url: "/test/operator-only",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(asUser.statusCode).toBe(403);
    expect(asUser.json<{ error: { code: string } }>().error.code).toBe("forbidden");
  });

  it("account update treats null as untouched and resets email verification", async () => {
    const token = (await login()).json<{ accessToken: string }>().accessToken;
    const patch = (payload: NonNullable<InjectOptions["payload"]>): Promise<InjectResponse> =>
      app.inject({
        method: "POST",
        url: "/api/v1/account",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });

    await patch({ displayName: "Named", avatarURL: "https://example.com/a.png" });

    // null means "leave alone" for every field — uniformly.
    const nulls = await patch({ displayName: null, avatarURL: null, description: null });
    expect(nulls.statusCode).toBe(200);
    const kept = nulls.json<{ displayName: string; avatarURL: string | null }>();
    expect(kept.displayName).toBe("Named");
    expect(kept.avatarURL).toBe("https://example.com/a.png");

    // An empty body is a valid no-op, not a 500.
    expect((await patch({})).statusCode).toBe(200);

    // Changing email clears verification; resending the same email does not.
    await app.pgSql!`UPDATE accounts SET email_verified_at = now() WHERE handle = ${HANDLE}`;
    const newEmail = `itest-auth-${RUN}-changed@example.com`;
    expect((await patch({ email: newEmail })).statusCode).toBe(200);
    const [afterChange] = await app.pgSql!`
      SELECT email_verified_at FROM accounts WHERE handle = ${HANDLE}`;
    expect(afterChange!.email_verified_at).toBeNull();

    await app.pgSql!`UPDATE accounts SET email_verified_at = now() WHERE handle = ${HANDLE}`;
    expect((await patch({ email: newEmail })).statusCode).toBe(200);
    const [afterSame] = await app.pgSql!`
      SELECT email_verified_at FROM accounts WHERE handle = ${HANDLE}`;
    expect(afterSame!.email_verified_at).not.toBeNull();

    // Taking another account's email is a 409, not a 500.
    const conflict = await patch({ email: EMAIL_OTHER });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ error: { code: string } }>().error.code).toBe("email_taken");

    await patch({ email: EMAIL });
  });

  it("rotation preserves the chain: session count and isCurrent are stable", async () => {
    const first = (await login()).json<{ accessToken: string; refreshToken: string }>();
    const listWith = (t: string) =>
      app.inject({
        method: "GET",
        url: "/api/v1/auth/sessions",
        headers: { authorization: `Bearer ${t}` },
      });

    const before = (await listWith(first.accessToken)).json<{ sessions: unknown[] }>();

    const rotated = (
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        payload: { refreshToken: first.refreshToken },
      })
    ).json<{ accessToken: string }>();

    const after = (await listWith(rotated.accessToken)).json<{
      sessions: { isCurrent: boolean }[];
    }>();
    // Old row revoked, successor live — the chain must not grow.
    expect(after.sessions).toHaveLength(before.sessions.length);
    expect(after.sessions.filter((s) => s.isCurrent)).toHaveLength(1);

    // The pre-rotation access token stays valid: the chain claim is unchanged.
    expect((await listWith(first.accessToken)).statusCode).toBe(200);
  });

  it("account delete requires password and kills access", async () => {
    const victim = `itest-auth-del-${RUN}`;
    const service = new AuthService(app.db!, app.env);
    await service.createAccount({
      handle: victim,
      email: `${victim}@example.com`,
      password: "delete-me-pw-123",
      displayName: "Del",
      role: "operator",
    });
    const { accessToken } = (await login(victim, "delete-me-pw-123")).json<{ accessToken: string }>();

    const del = await app.inject({
      method: "POST",
      url: "/api/v1/account/delete",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { password: "delete-me-pw-123" },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json<{ deleted: boolean }>().deleted).toBe(true);

    expect((await login(victim, "delete-me-pw-123")).statusCode).toBe(401);
  });
});
