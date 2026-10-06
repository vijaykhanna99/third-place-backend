import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { imageSize } from "image-size";
import { uuidv7 } from "uuidv7";
import type { Db } from "../../db/client.js";
import { images, uploads } from "../../db/schema/index.js";
import { errors } from "../../lib/errors.js";
import type { Storage } from "../../lib/storage.js";
import { mediaPrefixFor, tempKeyFor } from "../../jobs/extraction.js";

/** Presigned PUT lifetime — long enough for a multi-GB upload on a poor link. */
const UPLOAD_URL_TTL_SEC = 6 * 60 * 60;

export const IMAGE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  allowed: { "image/jpeg": ".jpg", "image/png": ".png" } as Record<string, string>,
} as const;

export interface UploadView {
  uploadID: string;
  status: "uploading" | "queued" | "processing" | "ready" | "failed";
  playlistURL: string | null;
  durationSec: number | null;
  error: string | null;
}

export class UploadService {
  constructor(
    private readonly db: Db,
    private readonly storage: Storage,
    /** Enqueues extraction; null when no queue is configured (dev without Redis). */
    private readonly enqueue: ((uploadId: string) => Promise<void>) | null,
    private readonly mediaBaseUrl: string,
    private readonly log?: { warn: (o: unknown, m?: string) => void },
  ) {}

  private toView(row: typeof uploads.$inferSelect): UploadView {
    return {
      uploadID: row.id,
      status: row.status,
      // Unsigned canonical URL; signed stream tokens arrive in step 7.
      playlistURL: row.playlistKey ? `${this.mediaBaseUrl}/${row.playlistKey}` : null,
      durationSec: row.durationSec,
      error: row.error,
    };
  }

  /** Step 1 (spec §8.1): reserve an upload and hand back a presigned PUT. */
  async initiate(
    accountId: string,
    input: { fileName: string; byteSize: number; checksum: string },
  ): Promise<{ uploadID: string; uploadURL: string; expiresAt: string; status: "uploading" }> {
    const id = uuidv7();
    await this.db.insert(uploads).values({
      id,
      r2Key: tempKeyFor(id),
      byteSize: input.byteSize,
      checksum: input.checksum.toLowerCase(),
      status: "uploading",
      createdBy: accountId,
    });

    // ContentLength is pinned into the signature: the operator cannot upload
    // something larger than they declared.
    const uploadURL = await this.storage.presignPut(
      tempKeyFor(id),
      UPLOAD_URL_TTL_SEC,
      input.byteSize,
    );

    return {
      uploadID: id,
      uploadURL,
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SEC * 1000).toISOString(),
      status: "uploading",
    };
  }

  /**
   * Step 2 (spec §8.2): confirm the object landed, then queue validation.
   * The checksum itself is verified by the worker while it streams the archive
   * — re-hashing multiple gigabytes inside a request would block the API.
   */
  async complete(accountId: string, uploadId: string): Promise<UploadView> {
    const row = await this.requireOwn(accountId, uploadId);

    // Already past this stage → return current state rather than re-queueing.
    if (row.status !== "uploading") return this.toView(row);

    let head: { size: number } | null;
    try {
      head = await this.storage.head(tempKeyFor(uploadId));
    } catch (err) {
      // Storage is down or misconfigured. That is our problem, not a missing
      // upload: say so with a retryable status instead of a 400.
      this.log?.warn(
        { uploadId, err: err instanceof Error ? err.message : String(err) },
        "storage head failed during complete",
      );
      throw errors.unavailable("Object storage is unavailable; call complete again later");
    }
    if (!head) {
      throw errors.validationFailed("No uploaded object found for this upload");
    }
    if (head.size !== row.byteSize) {
      await this.db
        .update(uploads)
        .set({
          status: "failed",
          error: `size_mismatch: expected ${String(row.byteSize)} bytes, stored ${String(head.size)}`,
        })
        .where(eq(uploads.id, uploadId));
      throw errors.conflict("checksum_mismatch", "Stored object does not match the declared size");
    }

    const [updated] = await this.db
      .update(uploads)
      .set({ status: "queued", error: null })
      .where(eq(uploads.id, uploadId))
      .returning();

    if (!this.enqueue) {
      // Without a queue the upload would sit in `queued` forever; say so
      // instead of leaving the operator polling a status that cannot change.
      await this.db
        .update(uploads)
        .set({ status: "failed", error: "no_worker: extraction queue is not configured" })
        .where(eq(uploads.id, uploadId));
      throw errors.internal("Extraction queue is not configured");
    }

    try {
      await this.enqueue(uploadId);
    } catch (err) {
      // No job exists for a `queued` row now, and nothing would ever create
      // one. Hand the row back to `uploading` so the operator can simply call
      // complete again once the queue is reachable.
      await this.db
        .update(uploads)
        .set({ status: "uploading" })
        .where(and(eq(uploads.id, uploadId), eq(uploads.status, "queued")));
      this.log?.warn(
        { uploadId, err: err instanceof Error ? err.message : String(err) },
        "extraction enqueue failed: upload reverted to uploading",
      );
      throw errors.unavailable("Extraction queue is unavailable; call complete again later");
    }

    return this.toView(updated!);
  }

  async status(accountId: string, uploadId: string): Promise<UploadView> {
    return this.toView(await this.requireOwn(accountId, uploadId));
  }

  private async requireOwn(accountId: string, uploadId: string) {
    const [row] = await this.db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
    // Not-found and not-yours are the same answer: an operator must not be able
    // to probe for other operators' upload ids.
    if (!row || row.createdBy !== accountId) throw errors.notFound("Upload not found");
    return row;
  }

  /** Thumbnail upload (spec §7.4) — small enough to proxy through the API. */
  async uploadImage(
    accountId: string,
    file: { buffer: Buffer; mimetype: string },
  ): Promise<{ imageID: string; url: string; byteSize: number; width: number; height: number }> {
    const ext = IMAGE_LIMITS.allowed[file.mimetype];
    if (!ext) throw errors.validationFailed("Only JPEG and PNG images are accepted");
    if (file.buffer.length > IMAGE_LIMITS.maxBytes) {
      throw errors.validationFailed("Image exceeds the 10 MB limit");
    }

    // Dimensions are parsed from the header, which doubles as a content check:
    // a file whose bytes are not really an image fails here.
    let width: number;
    let height: number;
    try {
      const dims = imageSize(file.buffer);
      if (!dims.width || !dims.height) throw new Error("no dimensions");
      if (dims.type !== "jpg" && dims.type !== "png") {
        throw errors.validationFailed("Image content does not match its declared type");
      }
      width = dims.width;
      height = dims.height;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err) throw err;
      throw errors.validationFailed("File is not a valid JPEG or PNG image");
    }

    const id = uuidv7();
    const key = `media/images/${id}${ext}`;
    await this.storage.put(key, file.buffer, { contentType: file.mimetype });
    const url = `${this.mediaBaseUrl}/${key}`;

    await this.db.insert(images).values({
      id,
      r2Key: key,
      url,
      byteSize: file.buffer.length,
      width,
      height,
      createdBy: accountId,
    });

    return { imageID: id, url, byteSize: file.buffer.length, width, height };
  }

  /** Convenience for tests and the janitor: the published prefix of an upload. */
  static mediaPrefix(uploadId: string): string {
    return mediaPrefixFor(uploadId);
  }

  static sha256(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
  }
}
