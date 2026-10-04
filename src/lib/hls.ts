/**
 * Minimal HLS playlist parsing, hand-rolled on purpose.
 *
 * This code runs against operator-supplied files, so it is deliberately small,
 * dependency-free, and readable: it extracts only the URIs and durations the
 * validator needs, and treats everything else as opaque text.
 */

export interface MasterPlaylist {
  /** URIs from EXT-X-STREAM-INF variants (quality renditions). */
  variants: string[];
  /** URIs from EXT-X-MEDIA (subtitles, alternate audio). */
  media: { uri: string; type: string; language: string | null }[];
}

export interface MediaPlaylist {
  /** Segment URIs, in order. */
  segments: string[];
  /** EXT-X-MAP init-segment URIs. */
  initSegments: string[];
  /** Sum of EXTINF durations, seconds. */
  durationSec: number;
}

/** Extracts a quoted or bare attribute from an EXT-X tag line. */
function attr(line: string, name: string): string | null {
  const quoted = new RegExp(`${name}="([^"]*)"`).exec(line);
  if (quoted) return quoted[1] ?? null;
  const bare = new RegExp(`${name}=([^,\\s]+)`).exec(line);
  return bare ? (bare[1] ?? null) : null;
}

function isUriLine(line: string): boolean {
  return line.length > 0 && !line.startsWith("#");
}

export function parseMaster(text: string): MasterPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants: string[] = [];
  const media: MasterPlaylist["media"] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      // The URI is the next non-comment, non-empty line.
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.length === 0) continue;
        if (isUriLine(next)) variants.push(next);
        break;
      }
    } else if (line.startsWith("#EXT-X-MEDIA")) {
      const uri = attr(line, "URI");
      if (uri) {
        media.push({
          uri,
          type: attr(line, "TYPE") ?? "",
          language: attr(line, "LANGUAGE"),
        });
      }
    }
  }
  return { variants, media };
}

export function parseMedia(text: string): MediaPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const segments: string[] = [];
  const initSegments: string[] = [];
  let durationSec = 0;

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      const value = Number.parseFloat(line.slice("#EXTINF:".length));
      if (Number.isFinite(value)) durationSec += value;
    } else if (line.startsWith("#EXT-X-MAP")) {
      const uri = attr(line, "URI");
      if (uri) initSegments.push(uri);
    } else if (isUriLine(line)) {
      segments.push(line);
    }
  }
  return { segments, initSegments, durationSec: Math.round(durationSec) };
}

export function isMasterPlaylist(text: string): boolean {
  return text.includes("#EXT-X-STREAM-INF");
}

/**
 * Resolves a playlist-relative URI against the playlist's own directory,
 * rejecting anything that escapes the upload root or is absolute.
 * Returns null when the URI is not a safe, in-tree relative reference.
 */
export function resolveRelative(fromPath: string, uri: string): string | null {
  // Absolute URLs and absolute paths are never followed: a playlist must only
  // reference files inside its own upload.
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith("/") || uri.startsWith("//")) return null;

  const base = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const parts = base.length > 0 ? base.split("/") : [];
  for (const segment of uri.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return null; // escapes the root
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}
