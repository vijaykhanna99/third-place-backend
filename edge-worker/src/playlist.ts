/**
 * Playlist token propagation (spec §5.2): every relative URI in an HLS
 * playlist gets `?token=` appended, so AVPlayer's follow-up fetches — media
 * playlists, segments, init sections, subtitle files, I-frame playlists —
 * carry the token without the client doing anything.
 *
 * Only relative references are rewritten. Absolute URLs never occur in our
 * bundles (extraction rejects them), and an absolute URL that did appear
 * would point outside this origin, where our token means nothing.
 */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function isRelativeUri(uri: string): boolean {
  return uri.length > 0 && !SCHEME.test(uri) && !uri.startsWith("//");
}

export function withToken(uri: string, token: string): string {
  if (!isRelativeUri(uri)) return uri;
  const hash = uri.indexOf("#");
  const base = hash === -1 ? uri : uri.slice(0, hash);
  const fragment = hash === -1 ? "" : uri.slice(hash);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}token=${encodeURIComponent(token)}${fragment}`;
}

/** Tags whose quoted URI attribute points at another resource of the bundle. */
const URI_ATTRIBUTE_TAGS = [
  "#EXT-X-MEDIA:",
  "#EXT-X-MAP:",
  "#EXT-X-I-FRAME-STREAM-INF:",
  "#EXT-X-SESSION-DATA:",
  "#EXT-X-KEY:",
  "#EXT-X-SESSION-KEY:",
  "#EXT-X-PART:",
  "#EXT-X-PRELOAD-HINT:",
  "#EXT-X-RENDITION-REPORT:",
];

export function rewritePlaylist(text: string, token: string): string {
  const lines = text.split("\n");
  const out = lines.map((rawLine) => {
    // Preserve CRLF endings byte for byte apart from the URI itself.
    const cr = rawLine.endsWith("\r");
    const line = cr ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();
    let rewritten = line;
    if (trimmed.length === 0) {
      rewritten = line;
    } else if (trimmed.startsWith("#")) {
      if (URI_ATTRIBUTE_TAGS.some((tag) => trimmed.startsWith(tag))) {
        rewritten = line.replace(/URI="([^"]*)"/g, (_m, uri: string) => `URI="${withToken(uri, token)}"`);
      }
    } else {
      rewritten = withToken(trimmed, token);
    }
    return cr ? `${rewritten}\r` : rewritten;
  });
  return out.join("\n");
}
