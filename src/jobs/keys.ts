/** Object-storage key layout for uploads (spec §5.1, §8.1). */

/** Temp key where the operator's presigned PUT lands. */
export function tempKeyFor(uploadId: string): string {
  return `tmp/uploads/${uploadId}.zip`;
}

/** Published media prefix — keyed per upload (one upload = one camera angle). */
export function mediaPrefixFor(uploadId: string): string {
  return `media/uploads/${uploadId}`;
}
