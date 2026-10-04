import type { FastifyInstance } from "fastify";
import { errors } from "../../lib/errors.js";
import { IMAGE_LIMITS, type UploadService } from "./service.js";

const uuid = { type: "string", format: "uuid" } as const;

/**
 * Upload routes (spec §7.4, §8). Operator-only, every one of them.
 * Video bytes never pass through here — only the presigned handshake and
 * status polling. Thumbnails are small enough to proxy.
 */
export function registerUploadRoutes(app: FastifyInstance, service: UploadService): void {
  const operatorOnly = { preValidation: app.requireRole("operator") };

  app.post(
    "/api/v1/uploads",
    {
      ...operatorOnly,
      schema: {
        body: {
          type: "object",
          required: ["fileName", "byteSize", "checksum"],
          properties: {
            fileName: { type: "string", minLength: 1, maxLength: 255 },
            byteSize: { type: "integer", minimum: 1, maximum: 10737418240 },
            checksum: { type: "string", pattern: "^[a-fA-F0-9]{64}$" },
          },
        },
      },
    },
    (req) =>
      service.initiate(
        req.auth!.accountId,
        req.body as { fileName: string; byteSize: number; checksum: string },
      ),
  );

  app.post(
    "/api/v1/uploads/:uploadID/complete",
    {
      ...operatorOnly,
      schema: {
        params: { type: "object", required: ["uploadID"], properties: { uploadID: uuid } },
      },
    },
    (req) => service.complete(req.auth!.accountId, (req.params as { uploadID: string }).uploadID),
  );

  app.get(
    "/api/v1/uploads/:uploadID",
    {
      ...operatorOnly,
      schema: {
        params: { type: "object", required: ["uploadID"], properties: { uploadID: uuid } },
      },
    },
    (req) => service.status(req.auth!.accountId, (req.params as { uploadID: string }).uploadID),
  );

  app.post("/api/v1/uploads/images", operatorOnly, async (req) => {
    if (!req.isMultipart()) {
      throw errors.validationFailed("Expected multipart/form-data with a `file` part");
    }
    const file = await req.file({ limits: { fileSize: IMAGE_LIMITS.maxBytes, files: 1 } });
    if (!file) throw errors.validationFailed("No file part in the request");

    const buffer = await file.toBuffer().catch(() => {
      throw errors.validationFailed("Image exceeds the 10 MB limit");
    });
    if (file.file.truncated) throw errors.validationFailed("Image exceeds the 10 MB limit");

    return service.uploadImage(req.auth!.accountId, { buffer, mimetype: file.mimetype });
  });
}
