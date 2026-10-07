import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { verifyStreamToken } from "../src/lib/stream-token.js";
import { makeZip } from "../test/helpers/zip-builder.js";
import { expectContract } from "../test/helpers/contract.js";

/**
 * End-to-end smoke test over HTTP against REAL processes: the built API
 * (`dist/index.js`) and the built worker (`dist/jobs/worker.js`), with
 * Postgres, Redis and S3-compatible storage from the environment. Exercises the
 * whole operator → viewer path the way the apps will:
 *
 *   operator CLI → login → initiate upload → PUT archive to the presigned URL →
 *   complete → worker extracts via BullMQ → program created with two angles →
 *   public reads with X-App-Key → stream tokens verified → playback metrics →
 *   viewCount → readiness, rate-limit headers, security headers.
 *
 *   pnpm build && pnpm e2e        (CI runs it after the test suite)
 *
 * Required env: DATABASE_URL, REDIS_URL, R2_ENDPOINT, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_BUCKET_MEDIA. Everything else is set here.
 */
const PORT = 3177;
const API = `http://127.0.0.1:${String(PORT)}`;
const APP_KEY = "e2e-app-key";
const SECRET = "e2e-stream-token-secret-0123456789";
const RUN = Date.now();
const HANDLE = `e2e-op-${String(RUN).slice(-8)}`;
const PASSWORD = "e2e-operator-password-1";

const required = ["DATABASE_URL", "REDIS_URL", "R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_MEDIA"];
for (const k of required) {
  if (!process.env[k]) {
    console.error(`e2e: ${k} is required`);
    process.exit(2);
  }
}
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  PORT: String(PORT),
  LOG_LEVEL: "warn",
  JWT_SIGNING_KEY: "e2e-jwt-signing-key-".padEnd(64, "x"),
  APP_KEYS: APP_KEY,
  STREAM_TOKEN_SECRET: SECRET,
  STREAM_TOKEN_TTL_SEC: "900",
  MEDIA_BASE_URL: `${process.env.R2_ENDPOINT!}/${process.env.R2_BUCKET_MEDIA!}/media`,
  QUEUE_PREFIX: `e2e-${String(RUN)}`,
  JANITOR_INTERVAL_MS: "0",
  TRUSTED_PROXIES: "",
};

let failures = 0;
function check(cond: unknown, label: string): void {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}`);
  }
}

const children: ChildProcess[] = [];
function start(name: string, script: string): ChildProcess {
  const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => console.log(`[${name}] exited with ${String(code)}`));
  children.push(child);
  return child;
}

async function waitFor(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`${url} did not become ready within ${String(timeoutMs)} ms`);
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="JA",LANGUAGE="ja",URI="subtitles/ja/subtitle.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=48000000,RESOLUTION=7680x4320,SUBTITLES="subs"
uhd8k/playlist.m3u8
`;
const MEDIA = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment-00001.ts\n#EXTINF:6.0,\nsegment-00002.ts\n#EXT-X-ENDLIST\n";
const SUBS = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nseg-00001.vtt\n#EXT-X-ENDLIST\n";
const bundle = (tag: string) =>
  makeZip([
    { path: "index.m3u8", content: MASTER },
    { path: "uhd8k/playlist.m3u8", content: MEDIA },
    { path: "uhd8k/segment-00001.ts", content: `segment-one-${tag}` },
    { path: "uhd8k/segment-00002.ts", content: `segment-two-${tag}` },
    { path: "subtitles/ja/subtitle.m3u8", content: SUBS },
    { path: "subtitles/ja/seg-00001.vtt", content: "WEBVTT\n\n00:00.000 --> 00:06.000\nhello\n" },
  ]);

const s3 = new S3Client({
  endpoint: process.env.R2_ENDPOINT!,
  region: "auto",
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
});

async function main(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
  try {
    // 0. Operator account through the real CLI.
    console.log("# operator:create");
    await new Promise<void>((resolve, reject) => {
      const cli = spawn(
        process.execPath,
        ["dist/cli/index.js", "operator:create", "--handle", HANDLE, "--email", `${HANDLE}@example.com`],
        { env: { ...env, OPERATOR_PASSWORD: PASSWORD }, stdio: ["ignore", "inherit", "inherit"] },
      );
      cli.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cli exit ${String(code)}`))));
    });

    // 1. Processes.
    console.log("# starting api and worker");
    start("api", "dist/index.js");
    start("worker", "dist/jobs/worker.js");
    await waitFor(`${API}/readyz`, 30_000);
    const ready = await fetch(`${API}/readyz`);
    check(ready.status === 200, "readyz answers 200 with all dependencies up");
    const health = await json<{ status: string }>(await fetch(`${API}/healthz`));
    check(health.status === "ok", "healthz reports ok");

    // 2. Gates and hardening.
    const noKey = await fetch(`${API}/api/v1/genres`);
    check(noKey.status === 403, "public read without X-App-Key is refused");
    check(noKey.headers.get("x-content-type-options") === "nosniff", "security headers present");
    check(noKey.headers.get("ratelimit-limit") === "60", "rate-limit headers present");

    // 3. Login.
    console.log("# login");
    const login = await fetch(`${API}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: HANDLE, password: PASSWORD }),
    });
    check(login.status === 200, "operator login");
    const { accessToken } = await json<{ accessToken: string }>(login);
    const authed = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };

    // 4. Two uploads (two camera angles) through the presigned flow and the real worker.
    console.log("# uploads");
    const uploadIds: string[] = [];
    for (const angle of ["main", "side"]) {
      const zip = bundle(angle);
      const init = await fetch(`${API}/api/v1/uploads`, {
        method: "POST",
        headers: authed,
        body: JSON.stringify({
          fileName: `${angle}.zip`,
          byteSize: zip.length,
          checksum: createHash("sha256").update(zip).digest("hex"),
        }),
      });
      check(init.status === 200, `initiate upload (${angle})`);
      const initBody = await json<{ uploadID: string; uploadURL: string }>(init);
      expectContract("POST", "/api/v1/uploads", 200, initBody);
      const put = await fetch(initBody.uploadURL, {
        method: "PUT",
        body: new Uint8Array(zip),
        headers: { "content-length": String(zip.length) },
      });
      check(put.ok, `presigned PUT to storage (${angle}) → ${String(put.status)}`);
      const complete = await fetch(`${API}/api/v1/uploads/${initBody.uploadID}/complete`, { method: "POST", headers: authed });
      const completeText = await complete.text();
      const completeBody = JSON.parse(completeText) as { status?: string };
      check(
        complete.status === 200 && completeBody.status === "queued",
        `complete → queued (${angle}) [${String(complete.status)} ${completeText.slice(0, 300)}]`,
      );

      let status = "";
      let error: string | null = null;
      for (let i = 0; i < 120 && status !== "ready" && status !== "failed"; i++) {
        await sleep(500);
        const res = await json<{ status: string; error: string | null; durationSec: number | null }>(
          await fetch(`${API}/api/v1/uploads/${initBody.uploadID}`, { headers: authed }),
        );
        status = res.status;
        error = res.error;
      }
      check(status === "ready", `worker extracted the archive via BullMQ (${angle}) → ${status} ${error ?? ""}`);
      uploadIds.push(initBody.uploadID);
    }

    // 5. Catalog: a genre (seeded server-side in v1) and a program with two angles.
    console.log("# catalog");
    const [genre] = await sql`INSERT INTO genres (id, name, description) VALUES (gen_random_uuid(), ${"e2e:Music " + String(RUN)}, 'e2e') RETURNING id`;
    const created = await fetch(`${API}/api/v1/programs`, {
      method: "POST",
      headers: authed,
      body: JSON.stringify({
        title: `e2e:Neon Nights ${String(RUN)}`,
        description: "End-to-end program",
        genreIDs: [genre!.id as string],
        thumbnailURL: "https://example.com/t.jpg",
        season: [
          {
            number: 1,
            title: "S1",
            description: "d",
            episodes: [
              {
                number: 1,
                title: "Opening Night",
                description: "d",
                publishedAt: "2026-07-01T00:00:00Z",
                streams: [
                  { name: "Main", uploadID: uploadIds[0] },
                  { name: "Side", uploadID: uploadIds[1] },
                ],
              },
            ],
          },
        ],
      }),
    });
    check(created.status === 200, "create program with two camera angles");
    const program = await json<{ id: string; season: { episodes: { id: string; durationSec: number }[] }[] }>(created);
    expectContract("POST", "/api/v1/programs", 200, program);
    const episode = program.season[0]!.episodes[0]!;
    check(episode.durationSec === 12, "episode duration comes from the extracted upload");

    // 6. Public reads.
    const withKey = { "x-app-key": APP_KEY };
    const detail = await fetch(`${API}/api/v1/programs/${program.id}`, { headers: withKey });
    check(detail.status === 200, "program detail with app key");
    expectContract("GET", "/api/v1/programs/{programID}", 200, await detail.clone().json());
    const search = await json<{ programs: { id: string }[] }>(
      await fetch(`${API}/api/v1/search?query=${encodeURIComponent("Neon Nights " + String(RUN))}`, { headers: withKey }),
    );
    check(search.programs.some((p) => p.id === program.id), "general search finds the program");
    const genres = await json<{ genres: { id: string; programCount: number }[] }>(await fetch(`${API}/api/v1/genres`, { headers: withKey }));
    check(genres.genres.some((g) => g.id === genre!.id && g.programCount === 1), "genre list counts the program");

    // 7. Stream tokens.
    console.log("# streams");
    const streamRes = await fetch(`${API}/api/v1/episodes/${episode.id}/stream`, { headers: withKey });
    check(streamRes.status === 200, "stream endpoint");
    const streams = await json<{ streams: { name: string; streamURL: string }[]; expiresAt: string }>(streamRes);
    expectContract("GET", "/api/v1/episodes/{episodeID}/stream", 200, streams);
    check(streams.streams.map((s) => s.name).join(",") === "Main,Side", "both angles in presentation order");
    for (const [i, s] of streams.streams.entries()) {
      const url = new URL(s.streamURL);
      const token = url.searchParams.get("token") ?? "";
      const verdict = verifyStreamToken(SECRET, token, { path: `uploads/${uploadIds[i]!}/uhd8k/segment-00001.ts` });
      check(verdict.ok, `token for angle ${s.name} verifies for its own prefix`);
      check(url.pathname.endsWith(`/uploads/${uploadIds[i]!}/index.m3u8`), `stream URL points at the public media path (${s.name})`);
      // The published object really exists under the storage key the public
      // path maps to (the edge Worker performs that mapping in production).
      const object = await s3.send(
        new GetObjectCommand({ Bucket: process.env.R2_BUCKET_MEDIA!, Key: `media/uploads/${uploadIds[i]!}/index.m3u8` }),
      );
      const text = await object.Body!.transformToString();
      check(text.includes("#EXT-X-STREAM-INF"), `master playlist published for ${s.name}`);
    }

    // 8. Telemetry and viewCount.
    console.log("# metrics");
    for (const event of ["start", "progress", "start"]) {
      const res = await fetch(`${API}/api/v1/metrics/playback`, {
        method: "POST",
        headers: { ...withKey, "content-type": "application/json" },
        body: JSON.stringify({ episodeID: episode.id, event, positionSec: 1, quality: "uhd8k", sessionUUID: "7d444840-9dc0-11d1-b245-5ffdce74fad2" }),
      });
      check(res.status === 202, `playback event ${event} → 202`);
    }
    const after = await json<{ viewCount: number }>(await fetch(`${API}/api/v1/programs/${program.id}`, { headers: withKey }));
    check(after.viewCount === 2, `viewCount reflects the two start events (got ${String(after.viewCount)})`);

    // 9. Soft delete stops token issuance immediately.
    const del = await fetch(`${API}/api/v1/episodes/${episode.id}/delete`, { method: "POST", headers: authed });
    check(del.status === 200, "episode soft-delete");
    const gone = await fetch(`${API}/api/v1/episodes/${episode.id}/stream`, { headers: withKey });
    check(gone.status === 404, "no more stream tokens for a deleted episode");

    // Cleanup of this run's rows (storage objects are reclaimed by the janitor rules in time).
    await sql`DELETE FROM programs WHERE title LIKE ${"e2e:%" + String(RUN)}`;
    await sql`DELETE FROM genres WHERE id = ${genre!.id as string}`;
    await sql`DELETE FROM playback_events WHERE episode_id = ${episode.id}`;
    await sql`DELETE FROM uploads WHERE created_by IN (SELECT id FROM accounts WHERE handle = ${HANDLE})`;
    await sql`DELETE FROM accounts WHERE handle = ${HANDLE}`;
  } finally {
    await sql.end({ timeout: 5 });
    for (const child of children) child.kill("SIGTERM");
    await sleep(1500);
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\ne2e: all checks passed" : `\ne2e: ${String(failures)} check(s) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err: unknown) => {
    console.error("e2e: aborted:", err instanceof Error ? err.stack : err);
    for (const child of children) child.kill("SIGKILL");
    process.exit(1);
  });
