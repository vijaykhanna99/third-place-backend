# Media module — stream-URL issuance (spec §5)

- `stream-urls.ts` — `StreamUrlIssuer`: the one place that turns an upload id into a
  tokenised master-playlist URL (`{MEDIA_BASE_URL}/uploads/{uploadID}/index.m3u8?token=…`).
  The catalog's program detail and the stream endpoint both use it.
- `service.ts` — `GET /api/v1/episodes/{episodeID}/stream`: every camera angle of a live
  episode with fresh tokens and a shared `expiresAt`. Deleted episodes/programs → 404.
- Token format: `src/lib/stream-token.ts`; validated at the edge by `edge-worker/`.
- Quality enum: `src/lib/quality.ts`.
