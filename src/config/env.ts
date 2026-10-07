import "dotenv/config";
import { z } from "zod";

/**
 * All environment configuration is validated here at boot. A missing or
 * malformed variable fails fast with a readable message instead of surfacing
 * as an undefined somewhere deep in a request handler.
 *
 * Every dependency is optional in development and tests so the app can boot
 * with a subset of its routes; under NODE_ENV=production the full set is
 * required (see PRODUCTION_REQUIRED below).
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
  /**
   * Namespace for the job queue's Redis keys (BullMQ `prefix`, default "bull").
   * Lets several deployments — or a test run next to a developer's worker —
   * share one Redis without seeing each other's jobs.
   */
  QUEUE_PREFIX: optional(z.string().regex(/^[A-Za-z0-9_-]+$/)),
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
  /** How often the worker runs the janitor sweep (step 8). 0 disables scheduling. */
  JANITOR_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(60 * 60 * 1000),

  // web console + viewer accounts (step 14)
  /**
   * Browser origins allowed to call the API (the operator console), as a
   * comma-separated list of exact origins — scheme, host and port, no path,
   * no wildcard (spec §2.5). Unset: CORS stays closed (native clients only).
   */
  CORS_ORIGINS: optional(z.string()),
  /** Opens POST /auth/register to the public (spec §3 Phase 2). Default closed. */
  REGISTRATION_OPEN: z
    .preprocess((v) => (v === "" ? undefined : v), z.enum(["true", "false"]).optional())
    .default("false"),
  /**
   * How account emails leave the process: `log` writes them to the log
   * (development, tests), `smtp` delivers through SMTP_URL.
   */
  MAIL_TRANSPORT: z
    .preprocess((v) => (v === "" ? undefined : v), z.enum(["log", "smtp"]).optional())
    .default("log"),
  /** smtp(s)://user:pass@host:port — required when MAIL_TRANSPORT=smtp. */
  SMTP_URL: optional(z.string().url()),
  /** From header for account emails, e.g. "Third Place <no-reply@3rd-place.co.jp>". */
  MAIL_FROM: optional(z.string().min(3)),
  /**
   * Public origin of the pages linked from account emails (the web console
   * serves /account/verify-email and /account/reset-password). No trailing slash.
   */
  ACCOUNT_LINKS_BASE_URL: optional(z.string().url()),
});

/**
 * Everything a production process needs to actually do its job. Development
 * and tests may run with any subset (routes that lack their dependency are
 * simply not registered); production must not boot half-configured and
 * discover the gap on the first request.
 */
const PRODUCTION_REQUIRED = [
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SIGNING_KEY",
  "APP_KEYS",
  "MEDIA_BASE_URL",
  "STREAM_TOKEN_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_MEDIA",
] as const;

const strictEnvSchema = envSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== "production") return;
  for (const key of PRODUCTION_REQUIRED) {
    const value = env[key];
    if (value === undefined || value.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: "required when NODE_ENV=production",
      });
    }
  }
  if (!env.R2_ENDPOINT && !env.R2_ACCOUNT_ID) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["R2_ENDPOINT"],
      message: "R2_ENDPOINT or R2_ACCOUNT_ID is required when NODE_ENV=production",
    });
  }
  // Account emails that only reach the log are lost for the person waiting for
  // them; production with registration open must deliver them for real.
  if (env.REGISTRATION_OPEN === "true" && env.MAIL_TRANSPORT !== "smtp") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["MAIL_TRANSPORT"],
      message: "must be smtp when REGISTRATION_OPEN=true in production",
    });
  }
  if (env.MAIL_TRANSPORT === "smtp" || env.REGISTRATION_OPEN === "true") {
    for (const key of ["SMTP_URL", "MAIL_FROM", "ACCOUNT_LINKS_BASE_URL"] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "required for account emails when NODE_ENV=production",
        });
      }
    }
  }
});

export type Env = z.infer<typeof envSchema> & {
  appKeys: string[];
  /** Fastify `trustProxy` value: hop count, CIDR list, or false. */
  trustProxy: number | string[] | false;
  /** Exact browser origins allowed by CORS; empty keeps CORS closed. */
  corsOrigins: string[];
  registrationOpen: boolean;
};

/**
 * Parses CORS_ORIGINS into normalised exact origins. Anything that is not a
 * plain http(s) origin — a path, a wildcard, a bare host — is a configuration
 * error: an allowlist that is wrong by one character is worse than none.
 */
function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins: string[] = [];
  for (const item of raw.split(",")) {
    // A trailing slash and letter case are forgiven; everything else must match.
    const value = item.trim().replace(/\/$/, "");
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid environment configuration:\n  CORS_ORIGINS: "${value}" is not an origin`);
    }
    const isOrigin =
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin.toLowerCase() === value.toLowerCase() &&
      !url.hostname.includes("*");
    if (!isOrigin) {
      throw new Error(
        `Invalid environment configuration:\n  CORS_ORIGINS: "${value}" must be an exact http(s) origin without path or wildcard`,
      );
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

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
export interface LoadEnvOptions {
  /**
   * Enforce the production dependency set (default). Tooling that needs only
   * a slice of the configuration — the migrator, the operator CLI, the
   * extraction worker, each of which checks its own inputs — passes false so
   * it can run inside a production container without the API's secrets.
   */
  strict?: boolean;
}

export function loadEnvFrom(
  source: Record<string, string | undefined>,
  { strict = true }: LoadEnvOptions = {},
): Env {
  const parsed = (strict ? strictEnvSchema : envSchema).safeParse(source);
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
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    registrationOpen: env.REGISTRATION_OPEN === "true",
  };
}

/** Runtime entrypoint: process.env (with .env applied) plus optional overrides. */
export function loadEnv(
  overrides: Record<string, string | undefined> = {},
  options: LoadEnvOptions = {},
): Env {
  return loadEnvFrom({ ...process.env, ...overrides }, options);
}
