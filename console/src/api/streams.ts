import type { Stream } from "./types";

const UPLOAD_PATH = /\/uploads\/([0-9a-fA-F-]{36})\/index\.m3u8/;

/**
 * The upload backing a camera angle. Newer backends return `uploadID` on each
 * stream; older ones only expose it inside `streamURL`
 * (`/uploads/{uploadID}/index.m3u8`), so fall back to parsing the path.
 */
export function streamUploadID(stream: Pick<Stream, "streamURL"> & { uploadID?: string | null }): string | null {
  if (typeof stream.uploadID === "string" && stream.uploadID !== "") return stream.uploadID;
  try {
    const match = UPLOAD_PATH.exec(new URL(stream.streamURL).pathname);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    const match = UPLOAD_PATH.exec(stream.streamURL);
    return match?.[1]?.toLowerCase() ?? null;
  }
}
