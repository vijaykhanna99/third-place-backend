import { parseArgs } from "node:util";
import { loadEnv } from "../config/env.js";
import { createDb } from "../db/client.js";
import { runJanitor } from "../jobs/janitor.js";
import { scratchRoot } from "../jobs/lifecycle.js";
import { Storage, storageConfigFromEnv } from "../lib/storage.js";
import { AuthService } from "../modules/auth/service.js";
import { generatePassword } from "../modules/auth/tokens.js";

/**
 * Operator tooling (spec §3): operator accounts are never created through the
 * API — only here, server-side.
 *
 *   pnpm cli operator:create --handle ops --email ops@3rd-place.co.jp \
 *     [--display-name "Third Place Ops"]
 *
 * A strong password is generated and printed ONCE. To choose your own, pass it
 * via the OPERATOR_PASSWORD environment variable — never as a flag: argv is
 * world-readable in `ps aux` and lands in shell history.
 */
const MIN_PASSWORD_LENGTH = 10;

const HELP = `Usage:
  pnpm cli operator:create --handle <handle> --email <email> [--display-name <name>]
  pnpm cli janitor:run

  operator:create — set OPERATOR_PASSWORD to choose the password (min ${MIN_PASSWORD_LENGTH} chars);
  otherwise a strong one is generated and printed once.
  janitor:run — one janitor sweep now (spec §8.5), printing the report as JSON;
  exits 1 if any rule failed. Needs DATABASE_URL and the R2_* storage settings.`;

/** One janitor sweep on demand — the worker runs the same function on its schedule. */
async function janitorRun(): Promise<void> {
  const env = loadEnv({}, { strict: false });
  const storageConfig = storageConfigFromEnv(env);
  if (!env.DATABASE_URL || !storageConfig) {
    console.error("janitor:run needs DATABASE_URL and the R2_* storage configuration");
    process.exit(1);
  }
  const { sql, db } = createDb(env.DATABASE_URL);
  try {
    const report = await runJanitor({
      db,
      storage: new Storage(storageConfig),
      scratchDir: scratchRoot(env.SCRATCH_DIR),
      log: {
        info: () => undefined,
        warn: (o, m) => console.error(JSON.stringify({ level: "warn", msg: m, ...(o as object) })),
      },
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length > 0) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function operatorCreate(argv: string[]): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        handle: { type: "string" },
        email: { type: "string" },
        "display-name": { type: "string" },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${HELP}`);
    process.exit(1);
  }

  const handle = values.handle;
  const email = values.email;
  if (!handle || !email) {
    console.error(HELP);
    process.exit(1);
  }
  if (!/^[a-z0-9-]{3,32}$/.test(handle)) {
    console.error("handle must be 3-32 chars of [a-z0-9-]");
    process.exit(1);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error("email is not a valid address");
    process.exit(1);
  }

  // Only the database is needed here; the API's production checks do not apply.
  const env = loadEnv({}, { strict: false });
  if (!env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — copy .env.example to .env and start `pnpm db:up`.");
    process.exit(1);
  }

  const supplied = process.env.OPERATOR_PASSWORD;
  if (supplied !== undefined && supplied.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `OPERATOR_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters (matching the API's policy).`,
    );
    process.exit(1);
  }
  const password = supplied ?? generatePassword();
  const { sql, db } = createDb(env.DATABASE_URL);
  try {
    const service = new AuthService(db, env);
    const account = await service.createAccount({
      handle,
      email,
      password,
      displayName: values["display-name"] ?? handle,
      role: "operator",
    });
    console.log(`operator created:
  did:     ${account.did}
  handle:  ${account.handle}
  email:   ${account.email}`);
    if (supplied === undefined) {
      console.log(`  password (shown once, store it now): ${password}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "operator:create":
    await operatorCreate(rest);
    break;
  case "janitor:run":
    await janitorRun();
    break;
  case undefined:
  case "help":
  case "--help":
    console.log(HELP);
    break;
  default:
    console.error(`unknown command: ${command}\n${HELP}`);
    process.exit(1);
}
