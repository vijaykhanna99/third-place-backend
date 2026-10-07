import type { Api } from "../api/endpoints";
import { describeError } from "../api/client";
import { hashFile, type HashOptions } from "./hashFile";
import { putWithProgress } from "./putWithProgress";
import type { UploadEvent, UploadStage } from "./uploadMachine";

export interface RunUploadOptions {
  api: Api;
  file: File;
  dispatch: (event: UploadEvent) => void;
  signal?: AbortSignal;
  /** Milliseconds between status polls (default 2000). */
  pollIntervalMs?: number;
  /** Test hook passed through to hashFile. */
  createWorker?: HashOptions["createWorker"];
  /** Test hook: replaces the storage PUT. */
  put?: typeof putWithProgress;
}

const MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB — one presigned PUT

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Drives one archive through the whole ingestion flow: streaming SHA-256 in
 * a worker → `POST /uploads` → presigned `PUT` with progress →
 * `POST /uploads/{id}/complete` → poll `GET /uploads/{id}` until ready/failed.
 * Every step reports through `dispatch` (see uploadMachine). Resolves with the
 * uploadID when the backend reports `ready`, or null when it failed/aborted.
 */
export async function runUpload(options: RunUploadOptions): Promise<string | null> {
  const { api, file, dispatch, signal } = options;
  const put = options.put ?? putWithProgress;
  let stage: UploadStage = "hashing";
  const fail = (error: string) => {
    dispatch({ type: "fail", stage, error });
    return null;
  };

  dispatch({ type: "start", fileName: file.name, byteSize: file.size });
  if (file.size === 0) return fail("The file is empty");
  if (file.size > MAX_BYTES) return fail("Archives are limited to 5 GiB per angle");

  try {
    const checksum = await hashFile(file, {
      onProgress: (bytes) => dispatch({ type: "hashProgress", bytesHashed: bytes }),
      ...(signal ? { signal } : {}),
      ...(options.createWorker ? { createWorker: options.createWorker } : {}),
    });
    dispatch({ type: "hashed", checksum });

    stage = "initiating";
    const initiated = await api.uploads.initiate({ fileName: file.name, byteSize: file.size, checksum });
    dispatch({ type: "initiated", uploadID: initiated.uploadID });

    stage = "uploading";
    await put(initiated.uploadURL, file, {
      onProgress: (bytes) => dispatch({ type: "putProgress", bytesSent: bytes }),
      ...(signal ? { signal } : {}),
    });
    dispatch({ type: "putDone" });

    stage = "completing";
    const completed = await api.uploads.complete(initiated.uploadID);
    if (completed.status === "failed") return fail(completed.error ?? "upload rejected");
    if (completed.status === "ready") {
      dispatch({ type: "completed", status: "processing" });
      dispatch({ type: "polled", status: "ready", durationSec: completed.durationSec, error: null });
      return initiated.uploadID;
    }
    dispatch({ type: "completed", status: completed.status === "processing" ? "processing" : "queued" });

    stage = "processing";
    const interval = options.pollIntervalMs ?? 2000;
    for (;;) {
      await sleep(interval, signal);
      const upload = await api.uploads.get(initiated.uploadID, signal);
      dispatch({ type: "polled", status: upload.status, durationSec: upload.durationSec, error: upload.error });
      if (upload.status === "ready") return initiated.uploadID;
      if (upload.status === "failed") return null;
    }
  } catch (err) {
    if (isAbort(err)) {
      dispatch({ type: "cancel" });
      return null;
    }
    return fail(describeError(err));
  }
}
