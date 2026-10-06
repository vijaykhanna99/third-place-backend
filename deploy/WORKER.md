# Cloudflare: R2 buckets and the media edge Worker

Everything below is a manual, one-time setup per environment. No part of it has been run.

## 1. R2 buckets

Dashboard → R2 → Create bucket: `tplace-media-staging`, then `tplace-media-prod`
(location hint: Asia-Pacific). Leave public access **off** — the Worker is the only reader.

Lifecycle rule (optional, defence in depth): expire objects under `tmp/uploads/` after 30 days.
The janitor deletes them after 7; the rule catches anything it misses.

## 2. S3 API credentials for the API and worker

R2 → Manage R2 API Tokens → Create API token:
- Permissions: **Object Read & Write**, scoped to the one bucket of that environment.
- Copy the Access Key ID / Secret Access Key into `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`,
  and the account id into `R2_ACCOUNT_ID` (the endpoint `https://<account>.r2.cloudflarestorage.com`
  is derived by the API).
- Presigned PUTs are signed with these credentials, so operators upload directly to R2.

## 3. Worker

```bash
cd edge-worker
pnpm install
npx wrangler login                                  # once, opens the browser
npx wrangler secret put STREAM_TOKEN_SECRET --env staging   # paste the API's value
pnpm deploy:staging
```

Production: `npx wrangler secret put STREAM_TOKEN_SECRET` then `pnpm deploy`.

Custom domain: in `wrangler.toml` uncomment the `routes = [{ pattern = "media….3rd-place.co.jp", custom_domain = true }]`
line of the environment (DNS for the zone must be on Cloudflare), redeploy, then set the API's
`MEDIA_BASE_URL` to `https://media….3rd-place.co.jp`. Until then the Worker answers on its
`*.workers.dev` URL, which works for staging.

Optional hardening: `REQUIRE_APP_KEY_FOR_PLAYLISTS = "true"` plus `wrangler secret put APP_KEYS`
demands `X-App-Key` on playlist requests. Only enable it once the client fetches playlists
through its own URLSession (AVPlayer does not send custom headers reliably — Decision D5).

## 4. Smoke test

With the API running against the same bucket:

```bash
# 1. a token-less media request is refused
curl -si https://media-staging.3rd-place.co.jp/uploads/00000000-0000-0000-0000-000000000000/index.m3u8 | head -1
#    HTTP/2 403

# 2. get a real stream URL from the API (any ready episode)
curl -s -H "X-App-Key: $APP_KEY" https://api-staging.3rd-place.co.jp/api/v1/episodes/$EPISODE/stream | jq -r '.streams[0].streamURL'

# 3. the master playlist comes back rewritten: every URI carries ?token=
curl -s "$STREAM_URL" | grep -E '\.m3u8|\.ts|\.m4s'

# 4. a segment through the edge: 200, immutable cache headers, Accept-Ranges
curl -sI "https://media-staging…/uploads/$UPLOAD/uhd8k/segment-00001.ts?token=$TOKEN" | grep -iE 'HTTP|cache-control|accept-ranges'

# 5. the same segment with a token for another upload: 403
```

Then play the episode in the visionOS app (Debug build pointed at staging).

## 5. Rotating the stream-token secret

1. Generate the new secret; set it on the Worker as `STREAM_TOKEN_SECRET` and the old one as
   `STREAM_TOKEN_SECRET_PREVIOUS`; deploy.
2. Set the new value on the API; restart.
3. After 15 minutes (the token TTL) delete `STREAM_TOKEN_SECRET_PREVIOUS` from the Worker.
