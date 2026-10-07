/// <reference lib="webworker" />
import { createSHA256 } from "hash-wasm";

/**
 * Streams a File through an incremental SHA-256 so multi-gigabyte archives
 * never sit in memory as one buffer. Posts progress in bytes and the final
 * lowercase hex digest.
 */
export interface HashWorkerRequest {
  type: "hash";
  file: File;
  chunkBytes?: number;
}
export type HashWorkerResponse =
  | { type: "progress"; bytes: number; total: number }
  | { type: "done"; hex: string }
  | { type: "error"; message: string };

const DEFAULT_CHUNK = 8 * 1024 * 1024;

async function hashFile(file: File, chunkBytes: number, post: (m: HashWorkerResponse) => void): Promise<void> {
  const hasher = await createSHA256();
  hasher.init();
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + chunkBytes, file.size);
    const chunk = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    hasher.update(chunk);
    offset = end;
    post({ type: "progress", bytes: offset, total: file.size });
  }
  post({ type: "done", hex: hasher.digest("hex").toLowerCase() });
}

self.addEventListener("message", (event: MessageEvent<HashWorkerRequest>) => {
  const message = event.data;
  hashFile(message.file, message.chunkBytes ?? DEFAULT_CHUNK, (m) => self.postMessage(m)).catch((err: unknown) => {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) } satisfies HashWorkerResponse);
  });
});
