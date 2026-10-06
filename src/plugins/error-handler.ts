import type { FastifyInstance } from "fastify";
import { AppError } from "../lib/errors.js";

/**
 * Global error + 404 handling. Guarantees every error response matches the
 * spec's shape (§2.3): { "error": { "code", "message" } }.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      void reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message } });
      return;
    }

    // Fastify built-in errors (body parse failures, schema validation, etc.)
    const known = err as { statusCode?: unknown; message?: unknown };
    const status = typeof known.statusCode === "number" ? known.statusCode : 500;
    if (status < 500 && req.routeOptions.config.dropInvalidBody) {
      // Telemetry sink (spec §9): an unparseable body is an invalid payload,
      // and invalid payloads are dropped with 202, never reported.
      void reply.status(202).send();
      return;
    }
    if (status < 500) {
      const code = status === 429 ? "rate_limited" : "validation_failed";
      const message = typeof known.message === "string" ? known.message : "Bad request";
      void reply.status(status).send({ error: { code, message } });
      return;
    }

    // Unexpected: log details, return an opaque 500.
    req.log.error({ err }, "unhandled error");
    void reply
      .status(500)
      .send({ error: { code: "internal_error", message: "Internal server error" } });
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.status(404).send({ error: { code: "not_found", message: "Route not found" } });
  });
}
