import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import { errors } from "../lib/errors.js";

/**
 * `X-App-Key` gate for public reads (spec §2.2, Decision D5).
 *
 * This is a first-pass filter, NOT authentication: the key ships inside the
 * app binary and can be extracted. Its job is to discourage casual scripted
 * access to the catalog; the real protection on media is the short-lived
 * signed stream token (spec §5).
 *
 * Multiple keys are accepted so a key can be rotated while an older client
 * build is still in the field.
 *
 * Note this gate cannot cover CDN fragment requests — AVPlayer does not
 * reliably attach custom headers to segment fetches.
 */
export function registerAppKeyGuard(app: FastifyInstance): void {
  const keys = app.env.appKeys.map((k) => Buffer.from(k));

  app.decorate("requireAppKey", (): preHandlerAsyncHookHandler => {
    return (req) => {
      // No keys configured → the gate is disabled outright rather than
      // silently rejecting everything (dev convenience; production sets keys).
      if (keys.length === 0) return Promise.resolve();

      const header = req.headers["x-app-key"];
      const presented = typeof header === "string" ? Buffer.from(header) : null;
      if (!presented) throw errors.appKeyRequired();

      // Constant-time compare against each accepted key.
      const matched = keys.some(
        (k) => k.length === presented.length && timingSafeEqual(k, presented),
      );
      if (!matched) throw errors.appKeyRequired();
      return Promise.resolve();
    };
  });
}

declare module "fastify" {
  interface FastifyInstance {
    requireAppKey: () => preHandlerAsyncHookHandler;
  }
}
