import type { FastifyInstance } from "fastify";
import { mediaPrefixFor } from "../../jobs/keys.js";
import { publicMediaUrl } from "../../lib/media-url.js";
import { CatalogService, type CreateProgramInput, type UpdateProgramInput } from "./service.js";

const uuid = { type: "string", format: "uuid" } as const;
const limitParam = { type: "integer", minimum: 1, maximum: 100, default: 20 } as const;

/**
 * Catalog routes (spec §6 public reads, §7 operator CMS).
 * Public reads are gated by X-App-Key; every write requires the operator role.
 */
export function registerCatalogRoutes(app: FastifyInstance): void {
  // Stream URLs are minted by the media module in step 7; until then the
  // catalog emits the canonical unsigned URL so the shape is already right.
  // Storage is keyed per UPLOAD (one upload = one camera angle).
  const service = new CatalogService(app.db!, (uploadId) =>
    publicMediaUrl(app.env.MEDIA_BASE_URL ?? "", `${mediaPrefixFor(uploadId)}/index.m3u8`),
  );

  const publicRead = { preValidation: app.requireAppKey() };
  const operatorOnly = { preValidation: app.requireRole("operator") };

  // ------------------------------------------------------------ reads

  app.get(
    "/api/v1/programs/:programID",
    {
      ...publicRead,
      schema: {
        params: { type: "object", required: ["programID"], properties: { programID: uuid } },
        querystring: {
          type: "object",
          properties: { seasonNumber: { type: "integer", minimum: 1 } },
        },
      },
    },
    (req) => {
      const { programID } = req.params as { programID: string };
      const { seasonNumber } = req.query as { seasonNumber?: number };
      return service.getProgram(programID, seasonNumber);
    },
  );

  app.get("/api/v1/genres", publicRead, () => service.listGenres());

  app.get(
    "/api/v1/genres/:genreID/programs",
    {
      ...publicRead,
      schema: {
        params: { type: "object", required: ["genreID"], properties: { genreID: uuid } },
        querystring: {
          type: "object",
          properties: { limit: limitParam, cursor: { type: "string", maxLength: 512 } },
        },
      },
    },
    (req) => {
      const { genreID } = req.params as { genreID: string };
      const { limit = 20, cursor } = req.query as { limit?: number; cursor?: string };
      return service.listProgramsByGenre(genreID, limit, cursor);
    },
  );

  app.get(
    "/api/v1/programs/:programID/episodes/search",
    {
      ...publicRead,
      schema: {
        params: { type: "object", required: ["programID"], properties: { programID: uuid } },
        querystring: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1, maxLength: 200 },
            limit: limitParam,
            cursor: { type: "string", maxLength: 512 },
          },
        },
      },
    },
    (req) => {
      const { programID } = req.params as { programID: string };
      const { query, limit = 20, cursor } = req.query as {
        query: string;
        limit?: number;
        cursor?: string;
      };
      return service.searchEpisodes(programID, query, limit, cursor);
    },
  );

  app.get(
    "/api/v1/search",
    {
      ...publicRead,
      schema: {
        querystring: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1, maxLength: 200 },
            limit: limitParam,
            cursor: { type: "string", maxLength: 512 },
          },
        },
      },
    },
    (req) => {
      const { query, limit = 20, cursor } = req.query as {
        query: string;
        limit?: number;
        cursor?: string;
      };
      return service.search(query, limit, cursor);
    },
  );

  // --------------------------------------------------------- operator CMS

  app.post(
    "/api/v1/programs",
    {
      ...operatorOnly,
      schema: {
        body: {
          type: "object",
          required: ["title", "description", "genreIDs", "thumbnailURL", "season"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            description: { type: "string", maxLength: 5000 },
            genreIDs: { type: "array", minItems: 1, uniqueItems: true, items: uuid },
            thumbnailURL: { type: "string", format: "uri", maxLength: 2048 },
            season: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["number", "title", "description", "episodes"],
                properties: {
                  number: { type: "integer", minimum: 1 },
                  title: { type: "string", minLength: 1, maxLength: 200 },
                  description: { type: "string", maxLength: 5000 },
                  episodes: {
                    type: "array",
                    minItems: 1,
                    items: {
                      type: "object",
                      required: ["number", "title", "description", "publishedAt", "streams"],
                      properties: {
                        number: { type: "integer", minimum: 1 },
                        title: { type: "string", minLength: 1, maxLength: 200 },
                        description: { type: "string", maxLength: 5000 },
                        durationSec: { type: "integer", minimum: 0 },
                        thumbnailURL: { type: "string", format: "uri", maxLength: 2048 },
                        publishedAt: { type: "string", format: "date-time" },
                        streams: {
                          type: "array",
                          minItems: 1,
                          maxItems: 8,
                          items: {
                            type: "object",
                            required: ["name", "uploadID"],
                            properties: {
                              name: { type: "string", minLength: 1, maxLength: 50 },
                              uploadID: uuid,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    (req) => service.createProgram(req.auth!.accountId, req.body as CreateProgramInput),
  );

  app.post(
    "/api/v1/programs/:programID/update",
    {
      ...operatorOnly,
      schema: {
        params: { type: "object", required: ["programID"], properties: { programID: uuid } },
        body: {
          type: "object",
          properties: {
            title: { type: ["string", "null"], minLength: 1, maxLength: 200 },
            description: { type: ["string", "null"], maxLength: 5000 },
            genreIDs: { type: ["array", "null"], minItems: 1, uniqueItems: true, items: uuid },
            thumbnailURL: { type: ["string", "null"], format: "uri", maxLength: 2048 },
            episodes: {
              type: "array",
              items: {
                type: "object",
                required: ["episodeID"],
                properties: {
                  episodeID: uuid,
                  title: { type: ["string", "null"], minLength: 1, maxLength: 200 },
                  description: { type: ["string", "null"], maxLength: 5000 },
                  thumbnailURL: { type: ["string", "null"], format: "uri", maxLength: 2048 },
                  publishedAt: { type: ["string", "null"], format: "date-time" },
                  streams: {
                    type: ["array", "null"],
                    minItems: 1,
                    maxItems: 8,
                    items: {
                      type: "object",
                      required: ["name", "uploadID"],
                      properties: {
                        name: { type: "string", minLength: 1, maxLength: 50 },
                        uploadID: uuid,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    (req) => {
      const { programID } = req.params as { programID: string };
      return service.updateProgram(programID, req.body as UpdateProgramInput);
    },
  );

  app.post(
    "/api/v1/programs/:programID/delete",
    {
      ...operatorOnly,
      schema: {
        params: { type: "object", required: ["programID"], properties: { programID: uuid } },
      },
    },
    (req) => service.deleteProgram((req.params as { programID: string }).programID),
  );

  app.post(
    "/api/v1/episodes/:episodeID/delete",
    {
      ...operatorOnly,
      schema: {
        params: { type: "object", required: ["episodeID"], properties: { episodeID: uuid } },
      },
    },
    (req) => service.deleteEpisode((req.params as { episodeID: string }).episodeID),
  );
}
