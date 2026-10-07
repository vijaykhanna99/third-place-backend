import type { Api } from "../api/endpoints";
import { ApiError } from "../api/client";
import type { HashWorkerResponse } from "./sha256.worker";
import { runUpload } from "./runUpload";
import { initialUploadState, uploadStateReducer, type UploadEvent, type UploadState } from "./uploadMachine";

/** A stand-in for the hash worker that reports progress then a fixed digest. */
class FakeWorker extends EventTarget {
  static digest = "f".repeat(64);
  postMessage(): void {
    queueMicrotask(() => {
      this.dispatchEvent(new MessageEvent<HashWorkerResponse>("message", { data: { type: "progress", bytes: 4, total: 8 } }));
      this.dispatchEvent(new MessageEvent<HashWorkerResponse>("message", { data: { type: "done", hex: FakeWorker.digest } }));
    });
  }
  terminate(): void {
    this.terminated = true;
  }
  terminated = false;
}
const createWorker = () => new FakeWorker() as unknown as Worker;

function fakeApi(statuses: ("queued" | "processing" | "ready" | "failed")[], error: string | null = null) {
  const polls = [...statuses];
  const initiate = vi.fn().mockResolvedValue({ uploadID: "u-1", uploadURL: "https://storage.test/put/u-1", expiresAt: "", status: "uploading" });
  const complete = vi.fn().mockResolvedValue({ uploadID: "u-1", status: "queued", playlistURL: null, durationSec: null, error: null });
  const get = vi.fn().mockImplementation(() => {
    const status = polls.shift() ?? "ready";
    return Promise.resolve({ uploadID: "u-1", status, playlistURL: null, durationSec: status === "ready" ? 12 : null, error: status === "failed" ? error : null });
  });
  return { api: { uploads: { initiate, complete, get } } as unknown as Api, initiate, complete, get };
}

function collector() {
  const events: UploadEvent[] = [];
  let state: UploadState = initialUploadState;
  return {
    events,
    dispatch: (event: UploadEvent) => {
      events.push(event);
      state = uploadStateReducer(state, event);
    },
    get state() {
      return state;
    },
  };
}

const file = new File([new Uint8Array(8)], "main.zip", { type: "application/zip" });

describe("runUpload", () => {
  it("hashes, initiates, PUTs, completes and polls until ready", async () => {
    const { api, initiate, complete, get } = fakeApi(["queued", "processing", "ready"]);
    const put = vi.fn().mockImplementation((_url: string, _file: Blob, opts: { onProgress?: (b: number, t: number) => void }) => {
      opts.onProgress?.(8, 8);
      return Promise.resolve();
    });
    const c = collector();
    const result = await runUpload({ api, file, dispatch: c.dispatch, pollIntervalMs: 1, createWorker, put });

    expect(result).toBe("u-1");
    expect(initiate).toHaveBeenCalledWith({ fileName: "main.zip", byteSize: 8, checksum: FakeWorker.digest });
    expect(put).toHaveBeenCalledWith("https://storage.test/put/u-1", file, expect.anything());
    expect(complete).toHaveBeenCalledWith("u-1");
    expect(get).toHaveBeenCalledTimes(3);
    expect(c.events.map((e) => e.type)).toEqual(["start", "hashProgress", "hashed", "initiated", "putProgress", "putDone", "completed", "polled", "polled", "polled"]);
    expect(c.state).toEqual({ phase: "ready", fileName: "main.zip", byteSize: 8, uploadID: "u-1", durationSec: 12 });
  });

  it("surfaces an extraction failure with the backend's error code", async () => {
    const { api } = fakeApi(["queued", "failed"], "invalid_archive: central directory corrupt");
    const c = collector();
    const result = await runUpload({ api, file, dispatch: c.dispatch, pollIntervalMs: 1, createWorker, put: vi.fn().mockResolvedValue(undefined) });
    expect(result).toBeNull();
    expect(c.state).toMatchObject({ phase: "failed", stage: "processing", uploadID: "u-1", error: "invalid_archive: central directory corrupt" });
  });

  it("reports API errors from initiate with their code and stage", async () => {
    const { api, initiate } = fakeApi([]);
    initiate.mockRejectedValue(new ApiError(400, "validation_failed", "Request validation failed"));
    const c = collector();
    const result = await runUpload({ api, file, dispatch: c.dispatch, pollIntervalMs: 1, createWorker, put: vi.fn() });
    expect(result).toBeNull();
    expect(c.state).toMatchObject({ phase: "failed", stage: "initiating", error: "validation_failed: Request validation failed" });
  });

  it("reports storage PUT failures without calling complete", async () => {
    const { api, complete } = fakeApi([]);
    const c = collector();
    await runUpload({ api, file, dispatch: c.dispatch, pollIntervalMs: 1, createWorker, put: vi.fn().mockRejectedValue(new Error("Storage rejected the upload (HTTP 403)")) });
    expect(complete).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ phase: "failed", stage: "uploading", uploadID: "u-1", error: "Storage rejected the upload (HTTP 403)" });
  });

  it("refuses empty files before touching the API", async () => {
    const { api, initiate } = fakeApi([]);
    const c = collector();
    await runUpload({ api, file: new File([], "empty.zip"), dispatch: c.dispatch, createWorker, put: vi.fn() });
    expect(initiate).not.toHaveBeenCalled();
    expect(c.state).toMatchObject({ phase: "failed", stage: "hashing", error: "The file is empty" });
  });

  it("ends in cancelled when aborted while polling", async () => {
    const { api } = fakeApi(Array.from({ length: 200 }, () => "queued" as const));
    const controller = new AbortController();
    const c = collector();
    const promise = runUpload({ api, file, dispatch: c.dispatch, pollIntervalMs: 5, createWorker, put: vi.fn().mockResolvedValue(undefined), signal: controller.signal });
    await vi.waitFor(() => expect(c.state.phase).toBe("processing"));
    controller.abort();
    expect(await promise).toBeNull();
    expect(c.state).toEqual({ phase: "cancelled", fileName: "main.zip" });
  });
});
