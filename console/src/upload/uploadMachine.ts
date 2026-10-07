/**
 * State machine for one camera-angle upload. Pure and framework-free so the
 * transitions can be unit tested; `runUpload` drives it against the API.
 *
 *   idle → hashing → initiating → uploading → completing → processing → ready
 *                                                                     ↘ failed
 */
export type UploadStage = "hashing" | "initiating" | "uploading" | "completing" | "processing";

export type UploadState =
  | { phase: "idle" }
  | { phase: "hashing"; fileName: string; byteSize: number; bytesHashed: number }
  | { phase: "initiating"; fileName: string; byteSize: number; checksum: string }
  | { phase: "uploading"; fileName: string; byteSize: number; checksum: string; uploadID: string; bytesSent: number }
  | { phase: "completing"; fileName: string; byteSize: number; uploadID: string }
  | { phase: "processing"; fileName: string; byteSize: number; uploadID: string; status: "queued" | "processing" }
  | { phase: "ready"; fileName: string; byteSize: number; uploadID: string; durationSec: number | null }
  | { phase: "failed"; fileName: string | null; byteSize: number | null; uploadID: string | null; stage: UploadStage; error: string }
  | { phase: "cancelled"; fileName: string | null };

export type UploadEvent =
  | { type: "start"; fileName: string; byteSize: number }
  | { type: "hashProgress"; bytesHashed: number }
  | { type: "hashed"; checksum: string }
  | { type: "initiated"; uploadID: string }
  | { type: "putProgress"; bytesSent: number }
  | { type: "putDone" }
  | { type: "completed"; status: "queued" | "processing" }
  | { type: "polled"; status: "uploading" | "queued" | "processing" | "ready" | "failed"; durationSec: number | null; error: string | null }
  | { type: "fail"; stage: UploadStage; error: string }
  | { type: "cancel" }
  | { type: "reset" };

export const initialUploadState: UploadState = { phase: "idle" };

/** True while the browser or the backend is still working on it. */
export function isUploadActive(state: UploadState): boolean {
  return (
    state.phase === "hashing" ||
    state.phase === "initiating" ||
    state.phase === "uploading" ||
    state.phase === "completing" ||
    state.phase === "processing"
  );
}

export function uploadStateReducer(state: UploadState, event: UploadEvent): UploadState {
  switch (event.type) {
    case "start":
      return { phase: "hashing", fileName: event.fileName, byteSize: event.byteSize, bytesHashed: 0 };
    case "hashProgress":
      if (state.phase !== "hashing") return state;
      return { ...state, bytesHashed: Math.min(event.bytesHashed, state.byteSize) };
    case "hashed":
      if (state.phase !== "hashing") return state;
      return { phase: "initiating", fileName: state.fileName, byteSize: state.byteSize, checksum: event.checksum };
    case "initiated":
      if (state.phase !== "initiating") return state;
      return {
        phase: "uploading",
        fileName: state.fileName,
        byteSize: state.byteSize,
        checksum: state.checksum,
        uploadID: event.uploadID,
        bytesSent: 0,
      };
    case "putProgress":
      if (state.phase !== "uploading") return state;
      return { ...state, bytesSent: Math.min(event.bytesSent, state.byteSize) };
    case "putDone":
      if (state.phase !== "uploading") return state;
      return { phase: "completing", fileName: state.fileName, byteSize: state.byteSize, uploadID: state.uploadID };
    case "completed":
      if (state.phase !== "completing") return state;
      return { phase: "processing", fileName: state.fileName, byteSize: state.byteSize, uploadID: state.uploadID, status: event.status };
    case "polled": {
      if (state.phase !== "processing") return state;
      if (event.status === "ready") {
        return { phase: "ready", fileName: state.fileName, byteSize: state.byteSize, uploadID: state.uploadID, durationSec: event.durationSec };
      }
      if (event.status === "failed") {
        return {
          phase: "failed",
          fileName: state.fileName,
          byteSize: state.byteSize,
          uploadID: state.uploadID,
          stage: "processing",
          error: event.error ?? "extraction failed",
        };
      }
      if (event.status === "uploading") return state; // complete has not landed yet
      return { ...state, status: event.status };
    }
    case "fail":
      return {
        phase: "failed",
        fileName: "fileName" in state ? state.fileName : null,
        byteSize: "byteSize" in state ? state.byteSize : null,
        uploadID: "uploadID" in state ? state.uploadID : null,
        stage: event.stage,
        error: event.error,
      };
    case "cancel":
      if (!isUploadActive(state)) return state;
      return { phase: "cancelled", fileName: "fileName" in state ? state.fileName : null };
    case "reset":
      return initialUploadState;
  }
}

/** 0..1 for the current stage, or null when the stage has no measurable progress. */
export function uploadProgressFraction(state: UploadState): number | null {
  switch (state.phase) {
    case "hashing":
      return state.byteSize === 0 ? 1 : state.bytesHashed / state.byteSize;
    case "uploading":
      return state.byteSize === 0 ? 1 : state.bytesSent / state.byteSize;
    case "ready":
      return 1;
    default:
      return null;
  }
}

export function uploadStateLabel(state: UploadState): string {
  switch (state.phase) {
    case "idle":
      return "No file selected";
    case "hashing":
      return "Computing checksum";
    case "initiating":
      return "Requesting upload slot";
    case "uploading":
      return "Uploading to storage";
    case "completing":
      return "Finalising upload";
    case "processing":
      return state.status === "queued" ? "Queued for extraction" : "Extracting and validating";
    case "ready":
      return "Ready";
    case "failed":
      return `Failed during ${state.stage}`;
    case "cancelled":
      return "Cancelled";
  }
}
