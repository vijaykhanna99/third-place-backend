import type { HashWorkerRequest, HashWorkerResponse } from "./sha256.worker";

export interface HashOptions {
  onProgress?: (bytes: number, total: number) => void;
  signal?: AbortSignal;
  /** Test hook: a worker factory; the default spawns the bundled hash worker. */
  createWorker?: () => Worker;
}

function defaultWorker(): Worker {
  return new Worker(new URL("./sha256.worker.ts", import.meta.url), { type: "module" });
}

/** SHA-256 (lowercase hex) of a File, computed in a Web Worker. */
export function hashFile(file: File, options: HashOptions = {}): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("Hashing aborted", "AbortError"));
      return;
    }
    const worker = (options.createWorker ?? defaultWorker)();
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Hashing aborted", "AbortError"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.addEventListener("message", (event: MessageEvent<HashWorkerResponse>) => {
      const message = event.data;
      switch (message.type) {
        case "progress":
          options.onProgress?.(message.bytes, message.total);
          break;
        case "done":
          cleanup();
          resolve(message.hex);
          break;
        case "error":
          cleanup();
          reject(new Error(`Hashing failed: ${message.message}`));
          break;
      }
    });
    worker.addEventListener("error", (event) => {
      cleanup();
      reject(new Error(`Hashing failed: ${event.message || "worker error"}`));
    });
    worker.postMessage({ type: "hash", file } satisfies HashWorkerRequest);
  });
}
