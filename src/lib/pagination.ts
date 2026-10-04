import { errors } from "./errors.js";

/**
 * Opaque keyset cursors (spec §2.1). The payload is base64url JSON, but
 * clients must treat it as opaque — the shape is free to change.
 *
 * Keyset, not OFFSET: pagination stays correct and cheap when rows are
 * inserted or soft-deleted between pages.
 */
export interface CatalogCursor {
  /** Row id of the last row on the previous page. */
  id: string;
  /** Optional sort key, when the ordering is not by id alone (ISO timestamp). */
  t?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(cursor: CatalogCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decodes and fully validates a cursor. `id` MUST be checked against the UUID
 * shape: it is compared against a uuid column, so anything else makes Postgres
 * raise 22P02 and surface as a 500 rather than a 400.
 */
export function decodeCursor(raw: string | undefined): CatalogCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const { id, t } = parsed as Partial<CatalogCursor>;
      const idOk = typeof id === "string" && UUID_RE.test(id);
      const tOk = t === undefined || (typeof t === "string" && !Number.isNaN(Date.parse(t)));
      if (idOk && tOk) return t === undefined ? { id } : { id, t };
    }
  } catch {
    // fall through
  }
  throw errors.validationFailed("Malformed cursor");
}
