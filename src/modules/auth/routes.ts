import type { FastifyInstance } from "fastify";
import { errors } from "../../lib/errors.js";
import { AuthService } from "./service.js";
import { LoginLimiter } from "./limiter.js";

const credentialString = { type: "string", minLength: 1, maxLength: 512 } as const;

/**
 * Auth + account routes (spec §4, contract paths /api/v1/auth/* and
 * /api/v1/account*). Registered only when DATABASE_URL and JWT_SIGNING_KEY
 * are configured (app.ts guards this).
 */
export function registerAuthRoutes(app: FastifyInstance): void {
  const service = new AuthService(app.db!, app.env, app.mailer);
  const limiter = new LoginLimiter(app.redis);

  // ---- Register (spec §4.1) — closed unless REGISTRATION_OPEN=true ----
  // Shares the public per-IP budget so a script cannot mint accounts, or
  // probe handles, faster than it can read the catalog.
  app.post(
    "/api/v1/auth/register",
    {
      preValidation: app.publicRateLimit(),
      schema: {
        body: {
          type: "object",
          required: ["handle", "email", "password", "displayName"],
          properties: {
            handle: { type: "string", minLength: 3, maxLength: 32, pattern: "^[a-z0-9-]+$" },
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 10, maxLength: 512 },
            displayName: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    async (req) => {
      if (!app.env.registrationOpen) throw errors.registrationClosed();
      const body = req.body as { handle: string; email: string; password: string; displayName: string };
      const deviceInfo = req.headers["user-agent"]?.slice(0, 200) ?? null;
      return service.register(body, deviceInfo);
    },
  );

  // ---- Login ----
  app.post(
    "/api/v1/auth/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["identifier", "password"],
          properties: { identifier: credentialString, password: credentialString },
        },
      },
    },
    async (req) => {
      const { identifier, password } = req.body as { identifier: string; password: string };
      // Pre-check uses the identifier bucket (no account resolved yet); once
      // login reports the real account we also consult/record its own bucket,
      // so handle and email cannot be used as two separate budgets.
      if (await limiter.isBlocked(identifier, req.ip)) throw errors.rateLimited();

      const deviceInfo = req.headers["user-agent"] ?? null;
      const { accountId, tokens } = await service.login(
        identifier,
        password,
        deviceInfo?.slice(0, 200) ?? null,
      );

      if (accountId && (await limiter.isAccountBlocked(accountId))) throw errors.rateLimited();

      if (!tokens) {
        await limiter.recordFailure(identifier, req.ip, accountId);
        throw errors.unauthenticated("Invalid credentials");
      }
      await limiter.clear(identifier, accountId);
      return tokens;
    },
  );

  // ---- Refresh rotation ----
  app.post(
    "/api/v1/auth/refresh",
    {
      schema: {
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: { refreshToken: credentialString },
        },
      },
    },
    (req) => service.rotate((req.body as { refreshToken: string }).refreshToken),
  );

  // ---- Logout (idempotent) ----
  app.post(
    "/api/v1/auth/logout",
    {
      schema: {
        body: {
          type: "object",
          required: ["refreshToken"],
          properties: { refreshToken: credentialString },
        },
      },
    },
    async (req) => {
      await service.logout((req.body as { refreshToken: string }).refreshToken);
      return { revoked: true };
    },
  );

  // ---- Sessions ----
  app.get(
    "/api/v1/auth/sessions",
    { preValidation: app.requireRole("any") },
    async (req) => ({
      sessions: await service.listSessions(req.auth!.accountId, req.auth!.chain),
    }),
  );

  app.post(
    "/api/v1/auth/sessions/:sessionID/revoke",
    {
      preValidation: app.requireRole("any"),
      schema: {
        params: {
          type: "object",
          required: ["sessionID"],
          properties: { sessionID: { type: "string", format: "uuid" } },
        },
      },
    },
    async (req) => {
      await service.revokeSession(
        req.auth!.accountId,
        (req.params as { sessionID: string }).sessionID,
      );
      return { revoked: true };
    },
  );

  // ---- Email verification / password reset (spec §4.7) ----
  // Links are emailed through app.mailer; without a mailer configured the
  // requests are accepted as no-ops and no token can exist, so every
  // presented token is invalid — the pre-provider behaviour.
  app.post(
    "/api/v1/auth/email/verify-request",
    { preValidation: app.requireRole("any") },
    async (req, reply) => {
      await service.requestEmailVerification(req.auth!.accountId);
      await reply.status(202).send();
    },
  );

  app.post(
    "/api/v1/auth/email/verify",
    {
      schema: {
        body: {
          type: "object",
          required: ["token"],
          properties: { token: credentialString },
        },
      },
    },
    (req) => service.verifyEmail((req.body as { token: string }).token),
  );

  app.post(
    "/api/v1/auth/password/reset-request",
    {
      preValidation: app.publicRateLimit(),
      schema: {
        body: {
          type: "object",
          required: ["identifier"],
          properties: { identifier: credentialString },
        },
      },
    },
    async (req, reply) => {
      await service.requestPasswordReset((req.body as { identifier: string }).identifier);
      await reply.status(202).send();
    },
  );

  app.post(
    "/api/v1/auth/password/reset",
    {
      schema: {
        body: {
          type: "object",
          required: ["token", "password"],
          properties: {
            token: credentialString,
            password: { type: "string", minLength: 10, maxLength: 512 },
          },
        },
      },
    },
    (req) => {
      const { token, password } = req.body as { token: string; password: string };
      return service.resetPassword(token, password);
    },
  );

  // ---- Account (spec §4.6) ----
  app.get("/api/v1/account", { preValidation: app.requireRole("any") }, (req) =>
    service.getAccount(req.auth!.accountId),
  );

  app.post(
    "/api/v1/account",
    {
      preValidation: app.requireRole("any"),
      schema: {
        body: {
          type: "object",
          properties: {
            displayName: { type: ["string", "null"], minLength: 1, maxLength: 64 },
            description: { type: ["string", "null"], maxLength: 5000 },
            avatarURL: { type: ["string", "null"], format: "uri", maxLength: 2048 },
            email: { type: ["string", "null"], format: "email" },
            password: {
              type: "object",
              required: ["current", "next"],
              properties: {
                current: credentialString,
                next: { type: "string", minLength: 10, maxLength: 512 },
              },
            },
          },
        },
      },
    },
    (req) =>
      service.updateAccount(
        req.auth!.accountId,
        req.body as Parameters<AuthService["updateAccount"]>[1],
      ),
  );

  app.post(
    "/api/v1/account/delete",
    {
      preValidation: app.requireRole("any"),
      schema: {
        body: {
          type: "object",
          required: ["password"],
          properties: { password: credentialString },
        },
      },
    },
    (req) =>
      service.deleteAccount(req.auth!.accountId, (req.body as { password: string }).password),
  );
}
