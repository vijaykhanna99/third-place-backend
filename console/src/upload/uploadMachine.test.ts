import { initialUploadState, isUploadActive, uploadProgressFraction, uploadStateLabel, uploadStateReducer, type UploadEvent, type UploadState } from "./uploadMachine";

function run(events: UploadEvent[], from: UploadState = initialUploadState): UploadState {
  return events.reduce(uploadStateReducer, from);
}

describe("uploadStateReducer", () => {
  it("walks the happy path from idle to ready", () => {
    let state = run([{ type: "start", fileName: "main.zip", byteSize: 1000 }]);
    expect(state).toEqual({ phase: "hashing", fileName: "main.zip", byteSize: 1000, bytesHashed: 0 });
    expect(isUploadActive(state)).toBe(true);

    state = run([{ type: "hashProgress", bytesHashed: 500 }], state);
    expect(uploadProgressFraction(state)).toBe(0.5);

    state = run([{ type: "hashed", checksum: "ab".repeat(32) }], state);
    expect(state.phase).toBe("initiating");

    state = run([{ type: "initiated", uploadID: "u1" }], state);
    expect(state).toMatchObject({ phase: "uploading", uploadID: "u1", bytesSent: 0 });

    state = run([{ type: "putProgress", bytesSent: 250 }], state);
    expect(uploadProgressFraction(state)).toBe(0.25);

    state = run([{ type: "putDone" }, { type: "completed", status: "queued" }], state);
    expect(state).toMatchObject({ phase: "processing", status: "queued" });
    expect(uploadStateLabel(state)).toBe("Queued for extraction");

    state = run([{ type: "polled", status: "processing", durationSec: null, error: null }], state);
    expect(state).toMatchObject({ phase: "processing", status: "processing" });

    state = run([{ type: "polled", status: "ready", durationSec: 5400, error: null }], state);
    expect(state).toEqual({ phase: "ready", fileName: "main.zip", byteSize: 1000, uploadID: "u1", durationSec: 5400 });
    expect(isUploadActive(state)).toBe(false);
    expect(uploadProgressFraction(state)).toBe(1);
  });

  it("clamps progress to the file size", () => {
    const state = run([{ type: "start", fileName: "a.zip", byteSize: 10 }, { type: "hashProgress", bytesHashed: 99 }]);
    expect(state).toMatchObject({ bytesHashed: 10 });
  });

  it("ignores events that do not belong to the current phase", () => {
    const hashing = run([{ type: "start", fileName: "a.zip", byteSize: 10 }]);
    expect(run([{ type: "putProgress", bytesSent: 5 }], hashing)).toBe(hashing);
    expect(run([{ type: "completed", status: "queued" }], hashing)).toBe(hashing);
    expect(run([{ type: "polled", status: "ready", durationSec: 1, error: null }], hashing)).toBe(hashing);
  });

  it("records a backend failure with the error text from the upload", () => {
    const processing = run([
      { type: "start", fileName: "a.zip", byteSize: 10 },
      { type: "hashed", checksum: "x" },
      { type: "initiated", uploadID: "u9" },
      { type: "putDone" },
      { type: "completed", status: "queued" },
    ]);
    const failed = run([{ type: "polled", status: "failed", durationSec: null, error: "missing_master_playlist: index.m3u8 not found" }], processing);
    expect(failed).toEqual({
      phase: "failed",
      fileName: "a.zip",
      byteSize: 10,
      uploadID: "u9",
      stage: "processing",
      error: "missing_master_playlist: index.m3u8 not found",
    });
    expect(uploadStateLabel(failed)).toBe("Failed during processing");
  });

  it("keeps waiting while the status is still uploading right after complete", () => {
    const processing = run([
      { type: "start", fileName: "a.zip", byteSize: 10 },
      { type: "hashed", checksum: "x" },
      { type: "initiated", uploadID: "u9" },
      { type: "putDone" },
      { type: "completed", status: "queued" },
    ]);
    expect(run([{ type: "polled", status: "uploading", durationSec: null, error: null }], processing)).toBe(processing);
  });

  it("records a client-side failure with the stage and keeps the known uploadID", () => {
    const uploading = run([
      { type: "start", fileName: "a.zip", byteSize: 10 },
      { type: "hashed", checksum: "x" },
      { type: "initiated", uploadID: "u2" },
    ]);
    const failed = run([{ type: "fail", stage: "uploading", error: "Storage rejected the upload (HTTP 403)" }], uploading);
    expect(failed).toMatchObject({ phase: "failed", stage: "uploading", uploadID: "u2", error: "Storage rejected the upload (HTTP 403)" });
  });

  it("can be cancelled while active, but not once settled", () => {
    const hashing = run([{ type: "start", fileName: "a.zip", byteSize: 10 }]);
    expect(run([{ type: "cancel" }], hashing)).toEqual({ phase: "cancelled", fileName: "a.zip" });
    const ready: UploadState = { phase: "ready", fileName: "a.zip", byteSize: 10, uploadID: "u", durationSec: 1 };
    expect(run([{ type: "cancel" }], ready)).toBe(ready);
  });

  it("resets to idle", () => {
    const ready: UploadState = { phase: "ready", fileName: "a.zip", byteSize: 10, uploadID: "u", durationSec: 1 };
    expect(run([{ type: "reset" }], ready)).toEqual(initialUploadState);
  });
});
