export interface PutOptions {
  onProgress?: (bytes: number, total: number) => void;
  signal?: AbortSignal;
}

export class StoragePutError extends Error {
  override name = "StoragePutError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Sends the archive to the presigned storage URL with an HTTP PUT. Uses
 * XMLHttpRequest because fetch gives no upload progress. The body is the
 * File itself, so the browser streams it from disk and sends exactly
 * `file.size` bytes — the presigned URL pins Content-Length to that number.
 */
export function putWithProgress(url: string, file: Blob, options: PutOptions = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => options.signal?.removeEventListener("abort", onAbort);

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
    });
    xhr.addEventListener("load", () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(file.size, file.size);
        resolve();
      } else {
        reject(new StoragePutError(xhr.status, `Storage rejected the upload (HTTP ${xhr.status})`));
      }
    });
    xhr.addEventListener("error", () => {
      done();
      reject(new StoragePutError(0, "Storage upload failed — check the bucket's CORS policy allows PUT from this origin"));
    });
    xhr.addEventListener("abort", () => {
      done();
      reject(new DOMException("Upload aborted", "AbortError"));
    });
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/zip");
    xhr.send(file);
  });
}
