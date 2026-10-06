import "dotenv/config";
import { z } from "zod";

/**
 * All environment configuration is validated here at boot. A missing or
 * malformed variable fails fast with a readable message instead of surfacing
 * as an undefined somewhere deep in a request handler.
 *
 * Variables for later steps (DB, auth, R2) are declared optional now and
 * tightened to required as each step wires them in.
 */
/** Treats empty-string env vars ("KEY=") as unset, so `.env` placeholders don't trip validation. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // step 3
  DATABASE_URL: optional(z.string().url()),
  REDIS_URL: optional(z.string().url()),

  // step 4
  JWT_SIGNING_KEY: optional(z.string().min(32)),
  JWT_KID: z.string().default("k1"),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // step 5
  APP_KEYS: z.string().default(""),

  /**
   * Trusted reverse-proxy hops in front of this process, as a comma-separated
   * CIDR/IP list (e.g. "10.0.0.0/8") or a hop count (e.g. "1").
   *
   * Leave EMPTY when the process is directly exposed. Never set to `true`:
   * trusting every peer lets any client forge X-Forwarded-For, which both
   * evades the per-IP login limiter and lets an attacker poison another
   * user's bucket. Conversely, leaving it empty *behind* a proxy collapses
   * every request to the proxy's address, turning the per-IP limiter into a
   * single global bucket — see the login limiter's account-keyed budget,
   * which is what actually protects individual accounts.
   */
  TRUSTED_PROXIES: optional(z.string()),

  // steps 6-7
  R2_ACCOUNT_ID: optional(z.string()),
  /** Explicit S3 endpoint. Set for MinIO locally; derived from the account id for R2. */
  R2_ENDPOINT: optional(z.string().url()),
  R2_ACCESS_KEY_ID: optional(z.string()),
  R2_SECRET_ACCESS_KEY: optional(z.string()),
  R2_BUCKET_MEDIA: optional(z.string()),
  STREAM_TOKEN_SECRET: optional(z.string().min(32)),
  STREAM_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
  MEDIA_BASE_URL: optional(z.string().url()),

  // extraction worker (step 6.5)
  /** Where archives are downloaded during extraction. Defaults to the OS temp dir. */
  SCRATCH_DIR: optional(z.string()),
  /** How long the worker waits for in-flight jobs on SIGTERM before forcing the close. */
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  /** Per-entry uncompressed size cap inside an upload archive. */
  UPLOAD_MAX_ENTRY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 1024 * 1024 * 1024),
  /** A `processing` upload older than this is treated as abandoned and reclaimed. */
  UPLOAD_STUCK_AFTER_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
});

export type Env = z.infer<typeof envSchema> & {
  appKeys: string[];
  /** Fastify `trustProxy` value: hop count, CIDR list, or false. */
  trustProxy: number | string[] | false;
};

function parseTrustProxy(raw: string | undefined): number | string[] | false {
  if (!raw) return false;
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops > 0) return hops;
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : false;
}

/**
 * Validates configuration from an explicit source object only — no implicit
 * process.env. Tests use this directly so a developer's local .env can never
 * change test results.
 */
export function loadEnvFrom(source: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const env = parsed.data;
  return {
    ...env,
    appKeys: env.APP_KEYS.split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0),
    trustProxy: parseTrustProxy(env.TRUSTED_PROXIES),
  };
}

/** Runtime entrypoint: process.env (with .env applied) plus optional overrides. */
export function loadEnv(overrides: Record<string, string | undefined> = {}): Env {
  return loadEnvFrom({ ...process.env, ...overrides });
}
