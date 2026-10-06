import type { Readable } from "node:stream";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "../config/env.js";

/**
 * Object storage (spec §5.1, Decision D4). Cloudflare R2 in production, MinIO
 * locally — both are S3-compatible, so only the endpoint differs.
 *
 * The API server never proxies video bytes: operators PUT straight to storage
 * via a presigned URL, and the extraction worker streams entries in and out.
 */
export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function storageConfigFromEnv(env: Env): StorageConfig | null {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET_MEDIA) return null;
  const endpoint =
    env.R2_ENDPOINT ??
    (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null);
  if (!endpoint) return null;
  return {
    endpoint,
    region: "auto",
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET_MEDIA,
  };
}

/** Thrown when DeleteObjects reports per-key failures inside an HTTP 200. */
export class StorageDeleteError extends Error {
  constructor(readonly failures: { key: string; code: string; message: string }[]) {
    super(
      `${String(failures.length)} object(s) could not be deleted: ${failures
        .slice(0, 5)
        .map((f) => `${f.key} (${f.code}: ${f.message})`)
        .join("; ")}`,
    );
    this.name = "StorageDeleteError";
  }
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}

export class Storage {
  private readonly client: S3Client;

  constructor(
    private readonly config: StorageConfig,
    client?: S3Client,
  ) {
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        // R2 and MinIO both want path-style addressing.
        forcePathStyle: true,
      });
  }

  /** Presigned PUT so the operator uploads directly to storage (spec §8.1). */
  presignPut(key: string, expiresInSec: number, contentLength?: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        ...(contentLength === undefined ? {} : { ContentLength: contentLength }),
      }),
      { expiresIn: expiresInSec },
    );
  }

  /**
   * Null means the object does not exist. Any other failure (timeout,
   * throttling, bad credentials, 5xx) is rethrown: during a storage incident
   * callers must report "storage unavailable", never "your file is missing".
   */
  async head(key: string): Promise<{ size: number } | null> {
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return { size: res.ContentLength ?? 0 };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
    );
    if (!res.Body) throw new Error(`Object has no body: ${key}`);
    return res.Body as Readable;
  }

  async put(
    key: string,
    body: Buffer | Readable,
    opts: { contentType?: string; contentLength?: number } = {},
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ...(opts.contentType ? { ContentType: opts.contentType } : {}),
        ...(opts.contentLength === undefined ? {} : { ContentLength: opts.contentLength }),
      }),
    );
  }

  /**
   * Streams a body of unknown length to storage as a multipart upload. Only a
   * few parts are ever buffered (partSize × queueSize), whatever the total —
   * this is how multi-GB archive entries move without being held in memory.
   * A failed upload aborts its multipart parts so nothing is left billable.
   */
  async putStream(key: string, body: Readable, opts: { contentType?: string } = {}): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ...(opts.contentType ? { ContentType: opts.contentType } : {}),
      },
      partSize: 8 * 1024 * 1024,
      queueSize: 4,
      leavePartsOnError: false,
    });
    await upload.done();
  }

  /**
   * DeleteObjects answers HTTP 200 even when some keys failed, listing them in
   * `Errors` — those are surfaced as a StorageDeleteError so a rollback that
   * only half worked is never mistaken for a clean one.
   */
  async delete(keys: string[]): Promise<void> {
    const failures: StorageDeleteError["failures"] = [];
    // DeleteObjects caps at 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      if (chunk.length === 0) continue;
      const res = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.config.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })) },
        }),
      );
      for (const e of res.Errors ?? []) {
        failures.push({ key: e.Key ?? "?", code: e.Code ?? "?", message: e.Message ?? "" });
      }
    }
    if (failures.length > 0) throw new StorageDeleteError(failures);
  }

  async listPrefix(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = res.NextContinuationToken;
    } while (token);
    return keys;
  }

  /** Removes everything under a prefix — used to roll back a failed extraction. */
  async deletePrefix(prefix: string): Promise<void> {
    await this.delete(await this.listPrefix(prefix));
  }
}
