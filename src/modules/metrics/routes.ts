import type { FastifyInstance } from "fastify";
import { MetricsService } from "./service.js";

/** One event is a few hundred bytes; anything near this limit is not telemetry. */
export const PLAYBACK_EVENT_BODY_LIMIT = 4 * 1024;

/**
 * Metrics routes (spec §9). Public, app-key gated, rate limited like every
 * public read. No request schema on purpose: the contract promises 202 for
 * invalid payloads, so validation happens in the service and failures are
 * dropped instead of answered with 400. The `dropInvalidBody` route config
 * extends that promise to bodies Fastify itself cannot parse (malformed JSON,
 * wrong media type, oversized) — see the error handler.
 */
export function registerMetricsRoutes(app: FastifyInstance): void {
  const service = new MetricsService(app.db!, app.log);

  app.post(
    "/api/v1/metrics/playback",
    {
      // onRequest, not preValidation: the gates must run before the body is
      // parsed, or an unparseable body would be "dropped" with 202 for callers
      // who never presented an app key.
      onRequest: [app.publicRateLimit(), app.requireAppKey()],
      bodyLimit: PLAYBACK_EVENT_BODY_LIMIT,
      config: { dropInvalidBody: true },
    },
    async (req, reply) => {
      await service.record(req.body);
      return reply.status(202).send();
    },
  );
}

declare module "fastify" {
  interface FastifyContextConfig {
    /** Answer 202 with an empty body to request-parsing failures (telemetry sinks). */
    dropInvalidBody?: boolean;
  }
}
