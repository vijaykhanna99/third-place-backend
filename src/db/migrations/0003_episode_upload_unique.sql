-- One live episode per upload, enforced by the database.
--
-- The service checks availability before claiming an upload, but that check and
-- the INSERT are separate statements: two concurrent createProgram calls could
-- both pass and both attach the same upload. A partial unique index closes the
-- race for good; the service maps the resulting 23505 to
-- 409 upload_already_attached.
--
-- Partial (WHERE deleted_at IS NULL) so a soft-deleted episode releases its
-- upload for reuse.

CREATE UNIQUE INDEX IF NOT EXISTS "episodes_upload_live_uq"
  ON "episodes" ("upload_id") WHERE "deleted_at" IS NULL;
