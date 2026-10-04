import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { accounts, sessions } from "../db/schema/index.js";
import { errors } from "../lib/errors.js";
import { verifyAccessToken, type AccessClaims, type Role } from "../modules/auth/tokens.js";

export interface AuthContext extends AccessClaims {
  accountId: string;
}

/**
 * Bearer authentication with immediate-revocation semantics: besides verifying
 * the JWT, we require a live session row in the token's chain. Password
 * change, logout, and account deletion therefore cut access within one DB
 * round-trip, not after the 15-minute JWT expiry. Acceptable cost — v1
 * protected routes are low-traffic operator endpoints (Decision D8).
 *
 * Roles are declared per endpoint (spec §3): `app.requireRole("operator")`.
 */
export function registerAuthGuard(app: FastifyInstance): void {
  const authenticate = async (req: FastifyRequest): Promise<AuthContext> => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw errors.unauthenticated();
    const claims = await verifyAccessToken(app.env, header.slice("Bearer ".length));

    const cutoff = new Date(Date.now() - app.env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    const [live] = await app
      .db!.select({ id: sessions.id })
      .from(sessions)
      .innerJoin(accounts, eq(sessions.accountId, accounts.id))
      .where(
        and(
          eq(sessions.chainId, claims.chain),
          isNull(sessions.revokedAt),
          gt(sessions.issuedAt, cutoff),
          isNull(accounts.deletedAt),
        ),
      )
      .limit(1);
    if (!live) throw errors.invalidToken();

    // Keep lastUsedAt meaningful — without this every session in
    // GET /auth/sessions reports its creation time forever, and the field
    // can't help an operator spot a stale or hijacked session. Fire-and-
    // forget: the request must not fail or wait on a bookkeeping write.
    void app
      .db!.update(sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(sessions.id, live.id))
      .catch((err: unknown) => {
        app.log.debug({ err }, "failed to bump session lastUsedAt");
      });

    return { ...claims, accountId: claims.sub };
  };

  app.decorate("requireRole", (role: Role | "any"): preHandlerAsyncHookHandler => {
    return async (req) => {
      const auth = await authenticate(req);
      if (role !== "any" && auth.role !== role) {
        throw errors.forbidden(`${role.charAt(0).toUpperCase() + role.slice(1)} role required`);
      }
      req.auth = auth;
    };
  });
}

declare module "fastify" {
  interface FastifyInstance {
    requireRole: (role: Role | "any") => preHandlerAsyncHookHandler;
  }
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
