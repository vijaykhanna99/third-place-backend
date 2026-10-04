import { index, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";

/**
 * Roles are declared from day one (spec §3) so adding `creator` later is
 * configuration, not refactoring. v1 only ever creates `operator` accounts.
 */
export const accountRole = pgEnum("account_role", ["operator", "creator", "user"]);

export const accounts = pgTable("accounts", {
  id: uuid("id")
    .primaryKey()
    .$defaultFn(() => uuidv7()),
  /** Opaque stable identifier, `did:tplace:{id}` in v1 (AT-Proto-compatible naming). */
  did: text("did").notNull().unique(),
  handle: text("handle").notNull().unique(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  description: text("description").notNull().default(""),
  avatarUrl: text("avatar_url"),
  passwordHash: text("password_hash").notNull(),
  role: accountRole("role").notNull().default("user"),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** Hash of the refresh token — the raw token is never stored (spec §4). */
    refreshHash: text("refresh_hash").notNull().unique(),
    /**
     * All refresh tokens rotated from one login share a chain. Reuse of a
     * consumed token invalidates the whole chain (spec §4).
     */
    chainId: uuid("chain_id").notNull(),
    deviceInfo: text("device_info"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("sessions_account_idx").on(t.accountId),
    index("sessions_chain_idx").on(t.chainId),
  ],
);
