import type { FastifyInstance } from "fastify";
import { MediaService } from "./service.js";

const uuid = { type: "string", format: "uuid" } as const;

/** Media routes (spec §5.3): public, app-key gated. */
export function registerMediaRoutes(app: FastifyInstance): void {
  const service = new MediaService(app.db!, app.streamUrls);

  app.get(
    "/api/v1/episodes/:episodeID/stream",
    {
      preValidation: [app.publicRateLimit(), app.requireAppKey()],
      schema: {
        params: { type: "object", required: ["episodeID"], properties: { episodeID: uuid } },
      },
    },
    (req) => service.streamsFor((req.params as { episodeID: string }).episodeID),
  );
}
