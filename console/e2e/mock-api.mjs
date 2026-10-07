#!/usr/bin/env node
/**
 * In-memory stand-in for the Third Place backend, used by the Playwright
 * suite. Implements the operator flow the console depends on — login/refresh
 * rotation, sessions, account, catalog reads with X-App-Key, program CMS
 * writes, the presigned upload handshake (including the storage PUT target
 * on the same port) and the two public token endpoints — with CORS open to
 * any origin. Nothing here is production code.
 *
 *   node e2e/mock-api.mjs            # MOCK_API_PORT (default 4100)
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_API_PORT ?? 4100);
const ORIGIN = `http://127.0.0.1:${PORT}`;
export const APP_KEY = "e2e-app-key";
export const OPERATOR = { handle: "ops", email: "ops@example.com", password: "operator-password-1", did: "did:tplace:01890a5d-ac96-774b-b111-00000000a001" };
export const VALID_VERIFY_TOKEN = "valid-verify-token";
export const VALID_RESET_TOKEN = "valid-reset-token";
const PROCESSING_STEP_MS = Number(process.env.MOCK_PROCESSING_MS ?? 250);

// ---------------------------------------------------------------- state
const now = () => new Date().toISOString();
const account = {
  did: OPERATOR.did,
  handle: OPERATOR.handle,
  email: OPERATOR.email,
  emailVerifiedAt: null,
  displayName: "Third Place Ops",
  description: "Operator account used by the end-to-end suite.",
  avatarURL: null,
  createdAt: "2026-08-06T03:00:00.000Z",
  updatedAt: "2026-08-06T03:00:00.000Z",
};
let password = OPERATOR.password;
/** sessionID -> { sessionID, refreshToken, accessToken, issuedAt, lastUsedAt, deviceInfo } */
const sessions = new Map();
const consumedRefreshTokens = new Set();

const genres = [
  { id: "01890a5d-ac96-774b-b111-000000000001", name: "Music", description: "Immersive live music experiences.", thumbnailURL: null },
  { id: "01890a5d-ac96-774b-b111-000000000002", name: "Sports", description: "Courtside and pitch-side.", thumbnailURL: null },
];
/** programID -> program (internal shape; deleted flag) */
const programs = new Map();
/** uploadID -> upload record */
const uploads = new Map();
/** uploadID -> Buffer stored through the presigned PUT */
const storage = new Map();

function seed() {
  const uploadID = "01890a5d-ac96-774b-b111-000000000801";
  uploads.set(uploadID, { uploadID, fileName: "seed.zip", byteSize: 1, checksum: "0".repeat(64), status: "ready", durationSec: 5400, error: null, attached: true, createdAt: now() });
  programs.set("01890a5d-ac96-774b-b111-000000000101", {
    id: "01890a5d-ac96-774b-b111-000000000101",
    title: "Neon Nights — Immersive Live",
    description: "An immersive concert series captured in 8K stereoscopic MV-HEVC.",
    thumbnailURL: "https://media.3rd-place.example/thumbs/neon-nights.jpg",
    genreIDs: [genres[0].id],
    createdAt: "2026-06-01T09:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    viewCount: 1284,
    deleted: false,
    seasons: [
      {
        id: "01890a5d-ac96-774b-b111-000000000201",
        number: 1,
        title: "World Tour 2026",
        description: "Six nights across three cities.",
        episodes: [
          {
            id: "01890a5d-ac96-774b-b111-000000000301",
            number: 1,
            title: "Opening Night — Tokyo",
            description: "The first night of the tour.",
            durationSec: 5400,
            thumbnailURL: null,
            publishedAt: "2026-07-01T12:00:00.000Z",
            streams: [{ name: "Main", uploadID }],
            deleted: false,
          },
        ],
      },
    ],
  });
}
seed();

// ---------------------------------------------------------------- helpers
const json = (res, status, body, headers = {}) => {
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "ratelimit-limit": "60",
    "ratelimit-remaining": "59",
    ...headers,
  });
  res.end(payload);
};
const error = (res, status, code, message, headers) => json(res, status, { error: { code, message } }, headers);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

function sessionFromBearer(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/.exec(header);
  if (!match) return null;
  for (const session of sessions.values()) {
    if (session.accessToken === match[1]) {
      session.lastUsedAt = now();
      return session;
    }
  }
  return null;
}

function issueSession(deviceInfo) {
  const session = {
    sessionID: randomUUID(),
    refreshToken: `rft_${randomUUID().replace(/-/g, "")}`,
    accessToken: `acc_${randomUUID().replace(/-/g, "")}`,
    issuedAt: now(),
    lastUsedAt: now(),
    deviceInfo,
  };
  sessions.set(session.sessionID, session);
  return session;
}

const tokenResponse = (session) => ({
  did: account.did,
  handle: account.handle,
  accessToken: session.accessToken,
  refreshToken: session.refreshToken,
  expiresIn: 900,
});

const genreRef = (id) => {
  const g = genres.find((x) => x.id === id);
  return g ? { id: g.id, name: g.name } : { id, name: "unknown" };
};

function episodeView(ep) {
  return {
    id: ep.id,
    number: ep.number,
    title: ep.title,
    description: ep.description,
    durationSec: ep.durationSec,
    thumbnailURL: ep.thumbnailURL,
    streams: ep.streams.map((s) => ({ name: s.name, uploadID: s.uploadID, streamURL: `${ORIGIN}/media/uploads/${s.uploadID}/index.m3u8?token=mock` })),
    publishedAt: ep.publishedAt,
  };
}
function programView(p) {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    thumbnailURL: p.thumbnailURL,
    genre: p.genreIDs.map(genreRef),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    viewCount: p.viewCount,
    owner: { did: account.did, handle: account.handle, displayName: account.displayName, avatarURL: null },
    viewer: { isFollowing: false, isFavorited: false },
    season: p.seasons.map((s) => ({ id: s.id, number: s.number, title: s.title, description: s.description, episodes: s.episodes.filter((e) => !e.deleted).map(episodeView) })),
  };
}
const summaryView = (p) => ({ id: p.id, title: p.title, description: p.description, thumbnailURL: p.thumbnailURL, genre: p.genreIDs.map(genreRef), updatedAt: p.updatedAt });
const livePrograms = () => [...programs.values()].filter((p) => !p.deleted);

const isUUID = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isHttpURL = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

/** Validates streams[] for create/update: returns an error tuple or null and marks uploads attached. */
function checkStreams(streams, allowAttachedTo) {
  if (!Array.isArray(streams) || streams.length < 1 || streams.length > 8) return [400, "validation_failed", "streams must hold 1..8 angles"];
  for (const s of streams) {
    if (typeof s?.name !== "string" || s.name.length < 1 || s.name.length > 50) return [400, "validation_failed", "Angle name invalid"];
    if (!isUUID(s.uploadID)) return [400, "validation_failed", "uploadID must be a UUID"];
    const upload = uploads.get(s.uploadID.toLowerCase());
    if (!upload) return [404, "not_found", `Upload ${s.uploadID} not found`];
    if (upload.status !== "ready") return [409, "upload_not_ready", "Upload is not in ready state"];
    if (upload.attached && upload.attachedTo !== allowAttachedTo) return [409, "upload_already_attached", "Upload is already attached to an episode"];
  }
  return null;
}

function scheduleExtraction(upload) {
  setTimeout(() => {
    if (upload.status !== "queued") return;
    upload.status = "processing";
    setTimeout(() => {
      if (upload.status !== "processing") return;
      const bytes = storage.get(upload.uploadID) ?? Buffer.alloc(0);
      if (!bytes.includes("index.m3u8")) {
        upload.status = "failed";
        upload.error = "missing_master_playlist: no index.m3u8 at the archive root";
        return;
      }
      upload.status = "ready";
      upload.durationSec = 12;
    }, PROCESSING_STEP_MS);
  }, PROCESSING_STEP_MS);
}

const uploadView = (u) => ({
  uploadID: u.uploadID,
  status: u.status,
  playlistURL: u.status === "ready" ? `${ORIGIN}/media/uploads/${u.uploadID}/index.m3u8` : null,
  durationSec: u.status === "ready" ? u.durationSec : null,
  error: u.status === "failed" ? u.error : null,
});

function paginate(items, limit, cursor) {
  const offset = cursor ? Number(Buffer.from(cursor, "base64url").toString("utf8")) || 0 : 0;
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  return { page, nextCursor: nextOffset < items.length ? Buffer.from(String(nextOffset)).toString("base64url") : null };
}

// ---------------------------------------------------------------- router
const requireAppKey = (req, res) => {
  if (req.headers["x-app-key"] !== APP_KEY) {
    error(res, 403, "app_key_required", "Missing or invalid app key");
    return false;
  }
  return true;
};
const requireOperator = (req, res) => {
  const session = sessionFromBearer(req);
  if (!session) {
    error(res, 401, "unauthenticated", "Authentication required");
    return null;
  }
  return session;
};

async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  const path = url.pathname;
  const method = req.method ?? "GET";
  const seg = path.split("/").filter(Boolean);

  if (path === "/healthz") return json(res, 200, { status: "ok", checks: { db: "ok", redis: "ok" } });

  // Storage: presigned PUT target.
  if (seg[0] === "storage" && seg[1] === "tmp" && seg[2] && method === "PUT") {
    const upload = uploads.get(seg[2]);
    if (!upload || url.searchParams.get("sig") !== upload.signature) {
      res.writeHead(403, { "content-type": "text/plain" });
      return res.end("SignatureDoesNotMatch");
    }
    const body = await readBody(req);
    if (Number(req.headers["content-length"]) !== upload.byteSize || body.length !== upload.byteSize) {
      res.writeHead(400, { "content-type": "text/plain" });
      return res.end("ContentLengthMismatch");
    }
    storage.set(upload.uploadID, body);
    res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` });
    return res.end();
  }

  if (seg[0] !== "api" || seg[1] !== "v1") return error(res, 404, "not_found", "Resource not found");
  const route = seg.slice(2);

  // ---- auth
  if (route[0] === "auth") {
    if (route[1] === "login" && method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body.identifier !== "string" || typeof body.password !== "string") return error(res, 400, "validation_failed", "Request validation failed");
      const idOk = body.identifier === account.handle || body.identifier === account.email;
      if (!idOk || body.password !== password) return error(res, 401, "unauthenticated", "Invalid credentials");
      return json(res, 200, tokenResponse(issueSession(req.headers["user-agent"]?.slice(0, 60) ?? null)));
    }
    if (route[1] === "refresh" && method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body.refreshToken !== "string") return error(res, 400, "validation_failed", "Request validation failed");
      if (consumedRefreshTokens.has(body.refreshToken)) {
        // Reuse: kill the chain.
        for (const s of sessions.values()) if (s.previousRefreshTokens?.has(body.refreshToken)) sessions.delete(s.sessionID);
        return error(res, 401, "invalid_token", "Invalid or expired token");
      }
      const session = [...sessions.values()].find((s) => s.refreshToken === body.refreshToken);
      if (!session) return error(res, 401, "invalid_token", "Invalid or expired token");
      consumedRefreshTokens.add(session.refreshToken);
      session.previousRefreshTokens ??= new Set();
      session.previousRefreshTokens.add(session.refreshToken);
      session.refreshToken = `rft_${randomUUID().replace(/-/g, "")}`;
      session.accessToken = `acc_${randomUUID().replace(/-/g, "")}`;
      session.lastUsedAt = now();
      return json(res, 200, tokenResponse(session));
    }
    if (route[1] === "logout" && method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body.refreshToken !== "string") return error(res, 400, "validation_failed", "Request validation failed");
      for (const s of sessions.values()) if (s.refreshToken === body.refreshToken) sessions.delete(s.sessionID);
      return json(res, 200, { revoked: true });
    }
    if (route[1] === "sessions" && route.length === 2 && method === "GET") {
      const current = requireOperator(req, res);
      if (!current) return;
      const list = [...sessions.values()]
        .sort((a, b) => (a.lastUsedAt < b.lastUsedAt ? 1 : -1))
        .map((s) => ({ sessionID: s.sessionID, issuedAt: s.issuedAt, lastUsedAt: s.lastUsedAt, deviceInfo: s.deviceInfo, isCurrent: s.sessionID === current.sessionID }));
      return json(res, 200, { sessions: list });
    }
    if (route[1] === "sessions" && route[3] === "revoke" && method === "POST") {
      const current = requireOperator(req, res);
      if (!current) return;
      if (!isUUID(route[2])) return error(res, 400, "validation_failed", "sessionID must be a UUID");
      if (!sessions.has(route[2])) return error(res, 404, "not_found", "Session not found");
      sessions.delete(route[2]);
      return json(res, 200, { revoked: true });
    }
    if (route[1] === "email" && route[2] === "verify" && method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body.token !== "string") return error(res, 400, "validation_failed", "Request validation failed");
      if (body.token !== VALID_VERIFY_TOKEN) return error(res, 401, "invalid_token", "Invalid or expired token");
      account.emailVerifiedAt = now();
      return json(res, 200, { verified: true });
    }
    if (route[1] === "password" && route[2] === "reset" && method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body.token !== "string" || typeof body.password !== "string") return error(res, 400, "validation_failed", "Request validation failed");
      if (body.password.length < 10) return error(res, 400, "validation_failed", "password must be at least 10 characters");
      if (body.token !== VALID_RESET_TOKEN) return error(res, 401, "invalid_token", "Invalid or expired token");
      return json(res, 200, { reset: true });
    }
    return error(res, 404, "not_found", "Resource not found");
  }

  // ---- account
  if (route[0] === "account" && route.length === 1) {
    if (!requireOperator(req, res)) return;
    if (method === "GET") return json(res, 200, account);
    if (method === "POST") {
      const body = await readJson(req);
      if (!body) return error(res, 400, "validation_failed", "Request validation failed");
      if (body.password) {
        if (typeof body.password.current !== "string" || typeof body.password.next !== "string" || body.password.next.length < 10) {
          return error(res, 400, "validation_failed", "password.next must be at least 10 characters");
        }
        if (body.password.current !== password) return error(res, 401, "unauthenticated", "Current password is incorrect");
        password = body.password.next;
      }
      if (typeof body.displayName === "string") account.displayName = body.displayName;
      if (typeof body.description === "string") account.description = body.description;
      account.updatedAt = now();
      return json(res, 200, account);
    }
  }

  // ---- catalog (app key)
  if (route[0] === "genres" && method === "GET") {
    if (!requireAppKey(req, res)) return;
    if (route.length === 1) {
      return json(res, 200, { genres: genres.map((g) => ({ ...g, programCount: livePrograms().filter((p) => p.genreIDs.includes(g.id)).length })) });
    }
    if (route[2] === "programs") {
      const genre = genres.find((g) => g.id === route[1]);
      if (!genre) return error(res, 404, "not_found", "Genre not found");
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
      const items = livePrograms().filter((p) => p.genreIDs.includes(genre.id));
      const { page, nextCursor } = paginate(items, limit, url.searchParams.get("cursor"));
      return json(res, 200, { genreID: genre.id, total: items.length, nextCursor, programs: page.map(summaryView) });
    }
  }
  if (route[0] === "search" && method === "GET") {
    if (!requireAppKey(req, res)) return;
    const q = (url.searchParams.get("query") ?? "").toLowerCase();
    if (!q) return error(res, 400, "validation_failed", "query is required");
    const results = livePrograms()
      .map((p) => {
        const programMatch = p.title.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
        const episodes = p.seasons.flatMap((s) => s.episodes.filter((e) => !e.deleted && (programMatch || e.title.toLowerCase().includes(q))).map((e) => ({ ...episodeView(e), seasonNumber: s.number })));
        if (!programMatch && episodes.length === 0) return null;
        return {
          id: p.id,
          title: p.title,
          description: p.description,
          thumbnailURL: p.thumbnailURL,
          genre: p.genreIDs.map(genreRef),
          matchedBy: programMatch ? "program" : "episode",
          episodes: episodes.slice(0, 20).map(({ streams: _s, ...rest }) => rest),
        };
      })
      .filter(Boolean);
    return json(res, 200, { query: q, total: results.length, nextCursor: null, programs: results });
  }
  if (route[0] === "programs" && route.length === 2 && method === "GET") {
    if (!requireAppKey(req, res)) return;
    const p = programs.get(route[1]);
    if (!p || p.deleted) return error(res, 404, "not_found", "Resource not found");
    return json(res, 200, programView(p));
  }
  if (route[0] === "programs" && route[2] === "episodes" && route[3] === "search" && method === "GET") {
    if (!requireAppKey(req, res)) return;
    const p = programs.get(route[1]);
    if (!p || p.deleted) return error(res, 404, "not_found", "Resource not found");
    const q = (url.searchParams.get("query") ?? "").toLowerCase();
    const episodes = p.seasons.flatMap((s) => s.episodes.filter((e) => !e.deleted && e.title.toLowerCase().includes(q)).map((e) => ({ ...episodeView(e), seasonNumber: s.number })));
    return json(res, 200, { query: q, programID: p.id, total: episodes.length, nextCursor: null, episodes: episodes.map(({ streams: _s, ...rest }) => rest) });
  }

  // ---- cms (bearer)
  if (route[0] === "programs" && route.length === 1 && method === "POST") {
    if (!requireOperator(req, res)) return;
    const body = await readJson(req);
    if (!body || typeof body.title !== "string" || body.title.length === 0 || body.title.length > 200) return error(res, 400, "validation_failed", "title invalid");
    if (!Array.isArray(body.genreIDs) || body.genreIDs.length === 0) return error(res, 400, "validation_failed", "genreIDs required");
    for (const id of body.genreIDs) if (!genres.some((g) => g.id === id)) return error(res, 404, "not_found", `Genre ${id} not found`);
    if (!isHttpURL(body.thumbnailURL)) return error(res, 400, "validation_failed", "thumbnailURL invalid");
    if (!Array.isArray(body.season) || body.season.length === 0) return error(res, 400, "validation_failed", "season required");
    for (const s of body.season) {
      if (!Array.isArray(s.episodes) || s.episodes.length === 0) return error(res, 400, "validation_failed", "episodes required");
      for (const e of s.episodes) {
        if (typeof e.title !== "string" || e.title.length === 0) return error(res, 400, "validation_failed", "episode title required");
        if (Number.isNaN(Date.parse(e.publishedAt))) return error(res, 400, "validation_failed", "publishedAt invalid");
        const failure = checkStreams(e.streams, null);
        if (failure) return error(res, ...failure);
      }
    }
    const ts = now();
    const program = {
      id: randomUUID(),
      title: body.title,
      description: body.description ?? "",
      thumbnailURL: body.thumbnailURL,
      genreIDs: [...new Set(body.genreIDs)],
      createdAt: ts,
      updatedAt: ts,
      viewCount: 0,
      deleted: false,
      seasons: body.season.map((s) => ({
        id: randomUUID(),
        number: s.number,
        title: s.title ?? "",
        description: s.description ?? "",
        episodes: s.episodes.map((e) => {
          const id = randomUUID();
          for (const st of e.streams) {
            const u = uploads.get(st.uploadID.toLowerCase());
            u.attached = true;
            u.attachedTo = id;
          }
          return {
            id,
            number: e.number,
            title: e.title,
            description: e.description ?? "",
            durationSec: uploads.get(e.streams[0].uploadID.toLowerCase()).durationSec ?? 0,
            thumbnailURL: e.thumbnailURL ?? null,
            publishedAt: new Date(e.publishedAt).toISOString(),
            streams: e.streams.map((st) => ({ name: st.name, uploadID: st.uploadID.toLowerCase() })),
            deleted: false,
          };
        }),
      })),
    };
    programs.set(program.id, program);
    return json(res, 200, programView(program));
  }
  if (route[0] === "programs" && route[2] === "update" && method === "POST") {
    if (!requireOperator(req, res)) return;
    const p = programs.get(route[1]);
    if (!p || p.deleted) return error(res, 404, "not_found", "Resource not found");
    const body = await readJson(req);
    if (!body) return error(res, 400, "validation_failed", "Request validation failed");
    if (body.title !== undefined && body.title !== null) {
      if (typeof body.title !== "string" || body.title.length === 0 || body.title.length > 200) return error(res, 400, "validation_failed", "title invalid");
    }
    if (body.thumbnailURL !== undefined && body.thumbnailURL !== null && !isHttpURL(body.thumbnailURL)) return error(res, 400, "validation_failed", "thumbnailURL invalid");
    if (body.genreIDs !== undefined && body.genreIDs !== null && (!Array.isArray(body.genreIDs) || body.genreIDs.length === 0)) return error(res, 400, "validation_failed", "genreIDs invalid");
    if (Array.isArray(body.episodes)) {
      for (const patch of body.episodes) {
        const ep = p.seasons.flatMap((s) => s.episodes).find((e) => e.id === patch.episodeID && !e.deleted);
        if (!ep) return error(res, 404, "not_found", `Episode ${patch.episodeID} not found`);
        if (patch.streams !== undefined && patch.streams !== null) {
          const failure = checkStreams(patch.streams, ep.id);
          if (failure) return error(res, ...failure);
        }
      }
      for (const patch of body.episodes) {
        const ep = p.seasons.flatMap((s) => s.episodes).find((e) => e.id === patch.episodeID);
        if (typeof patch.title === "string") ep.title = patch.title;
        if (typeof patch.description === "string") ep.description = patch.description;
        if (typeof patch.publishedAt === "string") ep.publishedAt = new Date(patch.publishedAt).toISOString();
        if (patch.thumbnailURL !== undefined) ep.thumbnailURL = patch.thumbnailURL;
        if (Array.isArray(patch.streams)) {
          for (const st of ep.streams) {
            const u = uploads.get(st.uploadID);
            if (u) u.attached = false;
          }
          ep.streams = patch.streams.map((st) => ({ name: st.name, uploadID: st.uploadID.toLowerCase() }));
          for (const st of ep.streams) {
            const u = uploads.get(st.uploadID);
            u.attached = true;
            u.attachedTo = ep.id;
          }
          ep.durationSec = uploads.get(ep.streams[0].uploadID).durationSec ?? ep.durationSec;
        }
      }
    }
    if (typeof body.title === "string") p.title = body.title;
    if (typeof body.description === "string") p.description = body.description;
    if (typeof body.thumbnailURL === "string") p.thumbnailURL = body.thumbnailURL;
    if (Array.isArray(body.genreIDs)) p.genreIDs = [...new Set(body.genreIDs)];
    p.updatedAt = now();
    return json(res, 200, programView(p));
  }
  if (route[0] === "programs" && route[2] === "delete" && method === "POST") {
    if (!requireOperator(req, res)) return;
    const p = programs.get(route[1]);
    if (!p || p.deleted) return error(res, 404, "not_found", "Resource not found");
    p.deleted = true;
    return json(res, 200, { targetType: "program", programID: p.id, episodeID: null, deleted: true, deletedAt: now() });
  }
  if (route[0] === "episodes" && route[2] === "delete" && method === "POST") {
    if (!requireOperator(req, res)) return;
    for (const p of livePrograms()) {
      const ep = p.seasons.flatMap((s) => s.episodes).find((e) => e.id === route[1] && !e.deleted);
      if (ep) {
        ep.deleted = true;
        p.updatedAt = now();
        return json(res, 200, { targetType: "episode", programID: p.id, episodeID: ep.id, deleted: true, deletedAt: now() });
      }
    }
    return error(res, 404, "not_found", "Resource not found");
  }

  // ---- uploads (bearer)
  if (route[0] === "uploads") {
    if (!requireOperator(req, res)) return;
    if (route[1] === "images" && method === "POST") {
      const raw = await readBody(req);
      if (!/^multipart\/form-data/.test(req.headers["content-type"] ?? "") || raw.length === 0) return error(res, 400, "validation_failed", "file is required");
      const imageID = randomUUID();
      return json(res, 200, { imageID, url: `${ORIGIN}/media/thumbs/${imageID}.jpg`, byteSize: raw.length, width: 1920, height: 1080 });
    }
    if (route.length === 1 && method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body.fileName !== "string" || !Number.isInteger(body.byteSize) || body.byteSize < 1 || body.byteSize > 5368709120 || !/^[a-f0-9]{64}$/.test(body.checksum ?? "")) {
        return error(res, 400, "validation_failed", "Request validation failed");
      }
      const uploadID = randomUUID();
      const signature = randomUUID().replace(/-/g, "");
      uploads.set(uploadID, { uploadID, fileName: body.fileName, byteSize: body.byteSize, checksum: body.checksum, signature, status: "uploading", durationSec: null, error: null, attached: false, createdAt: now() });
      return json(res, 200, { uploadID, uploadURL: `${ORIGIN}/storage/tmp/${uploadID}?sig=${signature}`, expiresAt: new Date(Date.now() + 3600_000).toISOString(), status: "uploading" });
    }
    const upload = uploads.get(route[1]);
    if (!upload) return error(res, 404, "not_found", "Resource not found");
    if (route[2] === "complete" && method === "POST") {
      if (upload.status !== "uploading") return json(res, 200, uploadView(upload));
      const bytes = storage.get(upload.uploadID);
      if (!bytes) return error(res, 400, "validation_failed", "No uploaded object found for this upload");
      if (bytes.length !== upload.byteSize) {
        upload.status = "failed";
        upload.error = "size_mismatch: stored object does not match the declared size";
        return error(res, 409, "checksum_mismatch", "Stored object does not match the declared size");
      }
      const digest = createHash("sha256").update(bytes).digest("hex");
      upload.status = "queued";
      if (digest !== upload.checksum) {
        upload.status = "failed";
        upload.error = "checksum_mismatch: archive digest differs from the declared checksum";
        return json(res, 200, uploadView(upload));
      }
      scheduleExtraction(upload);
      return json(res, 200, uploadView(upload));
    }
    if (route.length === 2 && method === "GET") return json(res, 200, uploadView(upload));
  }

  return error(res, 404, "not_found", "Resource not found");
}

const server = createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("access-control-allow-headers", "Authorization, Content-Type, X-App-Key");
  res.setHeader("access-control-expose-headers", "Retry-After, RateLimit-Limit, RateLimit-Remaining, ETag");
  res.setHeader("access-control-max-age", "600");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  handle(req, res).catch((err) => {
    console.error("mock-api:", err);
    if (!res.headersSent) error(res, 500, "internal_error", "Internal error");
    else res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock-api listening on ${ORIGIN} (operator ${OPERATOR.handle} / ${OPERATOR.password}, app key ${APP_KEY})`);
});
