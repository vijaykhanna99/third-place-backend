/**
 * Public media URLs (spec §5.1, contract "Multi-angle" convention).
 *
 * Storage keys carry a `media/` prefix (`media/uploads/{uploadID}/…`,
 * `media/images/{id}.png`); the public surface does not (`/uploads/{uploadID}/…`,
 * `/images/{id}.png`). MEDIA_BASE_URL is the public origin — the edge Worker in
 * production, which maps the public path back onto the storage key, or the
 * bucket's `media/` folder in local development, where the mapping is a URL prefix.
 *
 * Every URL the API hands out (stream URLs, upload playlistURL, thumbnail URLs)
 * goes through here so the two namespaces can never drift apart again.
 */
export const STORAGE_MEDIA_PREFIX = "media/";

/** Public path of a storage key: the key with the storage-only prefix removed. */
export function publicMediaPath(key: string): string {
  return key.startsWith(STORAGE_MEDIA_PREFIX) ? key.slice(STORAGE_MEDIA_PREFIX.length) : key;
}

export function publicMediaUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${publicMediaPath(key)}`;
}
