import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnvFrom } from "../src/config/env.js";
import { buildApp } from "../src/app.js";
import { MemoryMailer } from "../src/lib/mailer.js";
import { expectContract } from "./helpers/contract.js";

/**
 * Viewer registration, email verification and password reset (spec §4.1, §4.7)
 * with registration open and a capturing mailer. Requires Postgres:
 *   TEST_DATABASE_URL=postgres://tplace:tplace@localhost:5433/tplace pnpm test
 */
const DB_URL = process.env.TEST_DATABASE_URL;
const KEY = "d".repeat(64);
const RUN = Date.now();
const HANDLE = `itest-reg-${RUN}`;
const EMAIL = `itest-reg-${RUN}@example.com`;
const PASSWORD = "viewer-password-01";
const LINKS = "https://console.example";

function tokenFrom(text: string, path: string): string {
  const m = new RegExp(`${LINKS}${path}\\?token=([A-Za-z0-9_%.-]+)`).exec(text);
  expect(m, `link to ${path} in:\n${text}`).toBeTruthy();
  return decodeURIComponent(m![1]!);
}

describe.runIf(Boolean(DB_URL))("registration and account emails", () => {
  let app: FastifyInstance;
  const mailer = new MemoryMailer();

  beforeAll(async () => {
    app = buildApp(
      loadEnvFrom({
        NODE_ENV: "test",
        LOG_LEVEL: "error",
        DATABASE_URL: DB_URL!,
        JWT_SIGNING_KEY: KEY,
        REGISTRATION_OPEN: "true",
        ACCOUNT_LINKS_BASE_URL: LINKS,
      }),
      { mailer },
    );
    await app.pgSql!`DELETE FROM accounts WHERE handle LIKE 'itest-reg-%'`;
    await app.ready();
  });

  afterAll(async () => {
    await app.pgSql!`DELETE FROM accounts WHERE handle LIKE 'itest-reg-%'`;
    await app.close();
  });

  const register = (body: Record<string, unknown>, ip = "10.9.0.1") =>
    app.inject({ method: "POST", url: "/api/v1/auth/register", payload: body, remoteAddress: ip });

  let accessToken = "";
  let refreshToken = "";

  it("registers a viewer, signs them in and emails a verification link", async () => {
    const res = await register({ handle: HANDLE, email: EMAIL, password: PASSWORD, displayName: "Reg Itest" });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{
      did: string;
      handle: string;
      email: string;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    }>();
    expectContract("post", "/api/v1/auth/register", 200, body);
    expect(body.handle).toBe(HANDLE);
    expect(body.email).toBe(EMAIL);
    accessToken = body.accessToken;
    refreshToken = body.refreshToken;

    const [row] = await app.pgSql!<{ role: string; email_verified_at: Date | null }[]>`
      SELECT role, email_verified_at FROM accounts WHERE handle = ${HANDLE}`;
    expect(row!.role).toBe("user");
    expect(row!.email_verified_at).toBeNull();

    const mail = mailer.lastTo(EMAIL);
    expect(mail?.subject).toBe("Confirm your email address");
    expect(mail!.text).toContain(`${LINKS}/account/verify-email?token=`);

    const me = await app.inject({ url: "/api/v1/account", headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.statusCode).toBe(200);
    expectContract("get", "/api/v1/account", 200, me.json());
    expect(me.json<{ emailVerifiedAt: string | null }>().emailVerifiedAt).toBeNull();
  });

  it("rejects a taken handle and a malformed body", async () => {
    const taken = await register({ handle: HANDLE, email: `x-${EMAIL}`, password: PASSWORD, displayName: "Dup" });
    expect(taken.statusCode).toBe(409);
    expectContract("post", "/api/v1/auth/register", 409, taken.json());

    const short = await register({ handle: `${HANDLE}-b`, email: `b-${EMAIL}`, password: "short", displayName: "B" });
    expect(short.statusCode).toBe(400);
  });

  it("verifies the email with the emailed token, once", async () => {
    const token = tokenFrom(mailer.lastTo(EMAIL)!.text, "/account/verify-email");
    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/email/verify", payload: { token } });
    expect(ok.statusCode, ok.body).toBe(200);
    expectContract("post", "/api/v1/auth/email/verify", 200, ok.json());

    const me = await app.inject({ url: "/api/v1/account", headers: { authorization: `Bearer ${accessToken}` } });
    expect(me.json<{ emailVerifiedAt: string | null }>().emailVerifiedAt).not.toBeNull();

    const again = await app.inject({ method: "POST", url: "/api/v1/auth/email/verify", payload: { token } });
    expect(again.statusCode).toBe(401);
    expectContract("post", "/api/v1/auth/email/verify", 401, again.json());
  });

  it("verify-request is a no-op once verified and re-issues after an email change", async () => {
    const before = mailer.sent.length;
    const noop = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email/verify-request",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(noop.statusCode).toBe(202);
    expect(mailer.sent.length).toBe(before);

    const newEmail = `new-${EMAIL}`;
    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/account",
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { email: newEmail },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<{ emailVerifiedAt: string | null }>().emailVerifiedAt).toBeNull();

    const req = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email/verify-request",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(req.statusCode).toBe(202);
    const mail = mailer.lastTo(newEmail);
    expect(mail).toBeTruthy();
    const token = tokenFrom(mail!.text, "/account/verify-email");
    const ok = await app.inject({ method: "POST", url: "/api/v1/auth/email/verify", payload: { token } });
    expect(ok.statusCode).toBe(200);
  });

  it("only the latest verification token of an account is live", async () => {
    // Force the address back to unverified, request two links, the first must be dead.
    await app.pgSql!`UPDATE accounts SET email_verified_at = NULL WHERE handle = ${HANDLE}`;
    const auth = { authorization: `Bearer ${accessToken}` };
    await app.inject({ method: "POST", url: "/api/v1/auth/email/verify-request", headers: auth });
    const first = tokenFrom(mailer.sent.at(-1)!.text, "/account/verify-email");
    await app.inject({ method: "POST", url: "/api/v1/auth/email/verify-request", headers: auth });
    const second = tokenFrom(mailer.sent.at(-1)!.text, "/account/verify-email");
    expect(first).not.toBe(second);

    const stale = await app.inject({ method: "POST", url: "/api/v1/auth/email/verify", payload: { token: first } });
    expect(stale.statusCode).toBe(401);
    const live = await app.inject({ method: "POST", url: "/api/v1/auth/email/verify", payload: { token: second } });
    expect(live.statusCode).toBe(200);
  });

  it("password reset: unknown identifiers send nothing, known ones get a link that works once and revokes sessions", async () => {
    const before = mailer.sent.length;
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset-request",
      payload: { identifier: `nobody-${RUN}` },
      remoteAddress: "10.9.0.2",
    });
    expect(unknown.statusCode).toBe(202);
    expect(mailer.sent.length).toBe(before);

    const known = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset-request",
      payload: { identifier: HANDLE },
      remoteAddress: "10.9.0.2",
    });
    expect(known.statusCode).toBe(202);
    const mail = mailer.sent.at(-1)!;
    expect(mail.subject).toBe("Reset your password");
    const token = tokenFrom(mail.text, "/account/reset-password");

    const newPassword = "viewer-password-02";
    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token, password: newPassword },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expectContract("post", "/api/v1/auth/password/reset", 200, reset.json());

    // Every session died with the reset: the registration tokens are useless.
    const dead = await app.inject({ url: "/api/v1/account", headers: { authorization: `Bearer ${accessToken}` } });
    expect(dead.statusCode).toBe(401);
    const deadRefresh = await app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken } });
    expect(deadRefresh.statusCode).toBe(401);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier: HANDLE, password: PASSWORD },
      remoteAddress: "10.9.0.3",
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { identifier: HANDLE, password: newPassword },
      remoteAddress: "10.9.0.3",
    });
    expect(newLogin.statusCode).toBe(200);

    const reuse = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token, password: "viewer-password-03" },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("an expired token is refused", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset-request",
      payload: { identifier: HANDLE },
      remoteAddress: "10.9.0.4",
    });
    const token = tokenFrom(mailer.sent.at(-1)!.text, "/account/reset-password");
    await app.pgSql!`
      UPDATE account_tokens SET expires_at = now() - interval '1 minute'
      WHERE account_id = (SELECT id FROM accounts WHERE handle = ${HANDLE}) AND consumed_at IS NULL`;
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/reset",
      payload: { token, password: "viewer-password-04" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("registration shares the public per-IP rate limit", async () => {
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) {
      const res = await register(
        { handle: `${HANDLE}-rl-${i}`, email: `rl-${i}-${EMAIL}`, password: PASSWORD, displayName: "RL" },
        "10.9.0.99",
      );
      if (res.statusCode === 429) {
        limited = true;
        expectContract("post", "/api/v1/auth/register", 429, res.json());
      }
    }
    expect(limited).toBe(true);
  });
});
