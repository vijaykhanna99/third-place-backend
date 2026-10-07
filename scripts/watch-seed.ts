import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createDb } from "../src/db/client.js";
import { loadEnv } from "../src/config/env.js";
import { AuthService } from "../src/modules/auth/service.js";

/**
 * Seeds a watchable program through the real API: an operator account, one
 * upload per camera angle (ZIP → presigned PUT → complete → worker), then a
 * program whose single episode carries all angles. Prints the episode id and
 * the stream URLs. Used by scripts/watch-setup.sh; runnable on its own:
 *
 *   pnpm tsx scripts/watch-seed.ts --api http://127.0.0.1:3000 \
 *     --bundle Main=.watch/main.zip --bundle Side=.watch/side.zip [--title "Watch test"]
 *
 * Needs DATABASE_URL (operator + genre are created server-side, spec §3) and
 * APP_KEYS (first key is used for the public reads).
 */
const args = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const bundles = args.flatMap((a, i) => (a === "--bundle" ? [args[i + 1]!] : [])).map((spec) => {
  const eq = spec.indexOf("=");
  return { name: spec.slice(0, eq), path: spec.slice(eq + 1) };
});
const API = opt("api", "http://127.0.0.1:3000")!;
const TITLE = opt("title", `Watch test ${new Date().toISOString().slice(0, 16)}`)!;
if (bundles.length === 0) {
  console.error("at least one --bundle Name=path.zip is required");
  process.exit(2);
}

const env = loadEnv({}, { strict: false });
if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(2);
}
const appKey = env.appKeys[0] ?? "dev-app-key";
const HANDLE = "watch-operator";
const PASSWORD = "watch-operator-password-1";

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.url} → ${String(res.status)} ${text}`);
  return JSON.parse(text) as T;
}

async function main(): Promise<void> {
  const { sql, db } = createDb(env.DATABASE_URL!);
  try {
    // Operator (idempotent).
    const existing = await sql`SELECT id FROM accounts WHERE handle = ${HANDLE}`;
    if (existing.length === 0) {
      await new AuthService(db, env).createAccount({
        handle: HANDLE,
        email: `${HANDLE}@example.com`,
        password: PASSWORD,
        displayName: "Watch Operator",
        role: "operator",
      });
      console.log(`operator ${HANDLE} created`);
    }
    const { accessToken } = await json<{ accessToken: string }>(
      await fetch(`${API}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: HANDLE, password: PASSWORD }),
      }),
    );
    const authed = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

    // Uploads.
    const streams: { name: string; uploadID: string }[] = [];
    for (const b of bundles) {
      const zip = readFileSync(b.path);
      const init = await json<{ uploadID: string; uploadURL: string }>(
        await fetch(`${API}/api/v1/uploads`, {
          method: "POST",
          headers: authed,
          body: JSON.stringify({
            fileName: `${b.name}.zip`,
            byteSize: zip.length,
            checksum: createHash("sha256").update(zip).digest("hex"),
          }),
        }),
      );
      const put = await fetch(init.uploadURL, {
        method: "PUT",
        body: new Uint8Array(zip),
        headers: { "content-length": String(zip.length) },
      });
      if (!put.ok) throw new Error(`presigned PUT failed: ${String(put.status)} ${await put.text()}`);
      await json(await fetch(`${API}/api/v1/uploads/${init.uploadID}/complete`, { method: "POST", headers: authed }));
      process.stdout.write(`upload ${b.name} (${init.uploadID}) `);
      let status = "queued";
      let error: string | null = null;
      for (let i = 0; i < 600 && status !== "ready" && status !== "failed"; i++) {
        await sleep(1000);
        const res = await json<{ status: string; error: string | null }>(
          await fetch(`${API}/api/v1/uploads/${init.uploadID}`, { headers: authed }),
        );
        status = res.status;
        error = res.error;
        process.stdout.write(".");
      }
      console.log(` ${status}${error ? ` (${error})` : ""}`);
      if (status !== "ready") throw new Error(`upload ${b.name} did not become ready`);
      streams.push({ name: b.name, uploadID: init.uploadID });
    }

    // Genre + program.
    const [genre] = await sql`
      INSERT INTO genres (id, name, description) VALUES (gen_random_uuid(), 'Test footage', 'Synthetic stereo clips for playback checks')
      ON CONFLICT (name) DO UPDATE SET description = EXCLUDED.description RETURNING id`;
    const program = await json<{ id: string; season: { episodes: { id: string; streams: { name: string; streamURL: string }[] }[] }[] }>(
      await fetch(`${API}/api/v1/programs`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({
          title: TITLE,
          description: "Generated MV-HEVC test clip: moving marker in front of the screen plane, L/R eye markers, running clock.",
          genreIDs: [genre!.id as string],
          thumbnailURL: "https://3rd-place.co.jp/favicon.ico",
          season: [
            {
              number: 1,
              title: "Playback checks",
              description: "Each episode is one generated clip.",
              episodes: [
                {
                  number: 1,
                  title: "Stereo test pattern",
                  description: `Angles: ${bundles.map((b) => b.name).join(", ")}`,
                  publishedAt: new Date().toISOString(),
                  streams,
                },
              ],
            },
          ],
        }),
      }),
    );
    const episode = program.season[0]!.episodes[0]!;
    const streamRes = await json<{ streams: { name: string; streamURL: string }[]; expiresAt: string }>(
      await fetch(`${API}/api/v1/episodes/${episode.id}/stream`, { headers: { "x-app-key": appKey } }),
    );
    console.log(`\nprogram ${program.id}\nepisode ${episode.id}`);
    for (const s of streamRes.streams) console.log(`  ${s.name}: ${s.streamURL}`);
    console.log(`  tokens expire ${streamRes.expiresAt}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
