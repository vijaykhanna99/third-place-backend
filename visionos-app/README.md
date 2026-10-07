# Third Place — visionOS app (step 9)

SwiftUI client for Apple Vision Pro: browse genres and programs, search, open a program's
seasons and episodes, and play an episode's MV-HEVC HLS stream immersively with a camera-angle
switcher. Talks to the backend through the public, app-key-gated API only (`X-App-Key`).

> **Verified in CI, not yet on a device.** CI (`.github/workflows/ci.yml`, job "visionOS app")
> runs the API package's tests on macOS, generates the project with XcodeGen, builds the app
> for the visionOS simulator with the newest Xcode on the runner (26.3 at the time of writing)
> and runs the app's unit tests on a booted Apple Vision Pro simulator. What CI cannot do is
> play video: the immersive playback path has only been exercised by compiling it, so the
> first run on a device or simulator against the staging API is still a manual step.

## Layout

```
visionos-app/
  project.yml                     XcodeGen spec → ThirdPlace.xcodeproj (not committed)
  Config/Debug.xcconfig           API_BASE_URL / APP_KEY / MEDIA_ORIGIN for local dev
  Config/Release.xcconfig         production hosts — fill in before archiving
  Packages/ThirdPlaceAPI/         Swift package: API client + models from openapi.yaml + tests
  ThirdPlace/                     App target
    ThirdPlaceApp.swift           Scenes: catalog window, player window (per episode)
    AppConfig.swift / AppModel.swift
    Views/                        RootView (tabs), BrowseView (genres → programs, paginated),
                                  ProgramDetailView (+ EpisodeDetailView sheet), SearchView
    Player/                       PlayerCoordinator (AVPlayer, angles, token refresh, telemetry),
                                  PlayerWindowView (AVPlayerViewController + angle ornament)
```

## Build

Requirements: Xcode 16 or newer with the visionOS 2 SDK; [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`).

```bash
cd visionos-app
xcodegen generate                 # writes ThirdPlace.xcodeproj from project.yml
open ThirdPlace.xcodeproj
```

1. Select the `ThirdPlace` scheme and an Apple Vision Pro simulator (or a device).
2. Set your team under Signing & Capabilities (or `DEVELOPMENT_TEAM` in `project.yml`).
3. Debug builds read `Config/Debug.xcconfig`: API on `http://127.0.0.1:3000`, app key `dev-app-key`.
   Run the backend first (`pnpm dev` in the repo root, or `pnpm mock` for the contract's
   fixture universe on port 4010 — then change `API_BASE_URL` accordingly).
4. Run. Browse → genre → program → episode → Play.

Both test suites also run on every push in CI. Locally, the package tests need only a Swift
toolchain (macOS is fine, no Xcode project needed):

```bash
cd visionos-app/Packages/ThirdPlaceAPI
swift test
```

They decode the contract's own examples (`Tests/…/Fixtures/*.json`, copied from
`openapi.yaml`) and exercise the client against a stubbed transport (app-key header, query
building, error-envelope mapping, telemetry POST). The app target's tests
(`ThirdPlaceTests/`) run on the simulator: `xcodebuild test -scheme ThirdPlace -destination
'platform=visionOS Simulator,name=Apple Vision Pro'`.

## Watch without any setup (Vision Pro, one click)

Actions → **Publish test media** → *Run workflow*. A macOS runner renders the stereo test
clips and attaches them to the release
[`test-media`](https://github.com/vijaykhanna99/third-place-backend/releases/tag/test-media):
open that page in Safari on the Vision Pro while signed in to GitHub and tap
`stereo-test-main.mov`. It is a spatial MV-HEVC file, so Safari, Files and Photos play it in
3D: the orange marker floats in front of the screen, `L` and `R` each belong to one eye.
This checks the content and the headset; the streaming path (tokens, angle switching,
refresh) is checked with the setup below.

## Watch a real stream (Mac, Apple silicon)

One command stands up the backend, renders two MV-HEVC stereo test clips (two camera
angles), pushes them through the real upload pipeline and points the app at this machine:

```bash
scripts/watch-setup.sh            # simulator on this Mac
scripts/watch-setup.sh --device   # Apple Vision Pro on the same Wi-Fi (uses the Mac's LAN IP)
```

Options: `--ttl 120` (stream-token TTL in seconds, default 180) and `--seconds 300` (clip
length, default 240). The script leaves the API and worker running (`scripts/watch-stop.sh`
stops them) and prints the episode. Then open `ThirdPlace.xcodeproj`, run the `ThirdPlace`
scheme, and go Browse → Test footage → Watch test → Stereo test pattern → Play.

What to check:

| Check | Expect |
|---|---|
| Stereo | On a Vision Pro the orange marker floats clearly in front of the screen; the `L`/`R` corner letters each belong to one eye (close one eye). The simulator shows a flat 2D image, which is expected. |
| Angle switch | The bottom ornament lists `Main` and `Side`. Switching changes the label (MAIN ↔ SIDE) and colour; the clock keeps running from the same position. |
| Token refresh | With the default TTL of 180 s the player fetches new URLs after about 120 s and swaps the item at the same position. Watch the clock around 2:00: a short pause or a repeated second is the swap. Decide whether that is acceptable or raise `STREAM_TOKEN_TTL_SEC` (and set `--ttl` here to try other values). |
| Telemetry | `curl -s -H 'X-App-Key: dev-app-key' http://127.0.0.1:3000/api/v1/programs/<id> | jq .viewCount` increments per play. |

The test clips come from `tools/mvhevc` (`make-bundle`), a macOS command-line tool that
renders a synthetic scene and encodes it as MV-HEVC with VideoToolbox, writing fMP4
segments and playlists in the bundle layout the pipeline expects. CI builds the same tool
on a macOS runner, renders two short bundles and pushes them through the real pipeline, so
the generator is proven before you run it. Locally the bucket is served straight by MinIO
(public read, no edge Worker), so URLs are unsigned; the refresh behaviour is identical.

## How playback works

- `EpisodeDetailView` → **Play** opens the player window with the episode id. The player
  always calls `GET /api/v1/episodes/{id}/stream` for fresh tokenised URLs (spec §5.3) rather
  than reusing the ones embedded in program detail.
- `AVPlayerViewController` plays the master playlist; MV-HEVC renders stereoscopically and the
  experience controller requests the immersive experience (`AVExperienceController`, visionOS 2).
  The edge Worker rewrites playlist URIs so every segment request carries the token.
- **Camera angles**: the bottom ornament lists `streams[]`; selecting one swaps the player item to
  that angle's master playlist and seeks to the current position.
- **Token refresh**: tokens live 15 minutes. One minute before `expiresAt` the coordinator fetches
  `/stream` again and swaps in a new item at the same position (VOD playlists are fetched once,
  so AVPlayer would otherwise keep requesting segments with the expired token). Segments are
  cached at the edge without the token, so the swap re-reads from cache; a brief rebuffer at
  that moment is expected in v1. If a longer uninterrupted session matters, raise
  `STREAM_TOKEN_TTL_SEC` on the API (the Worker needs no change) or move the refresh to an
  `AVAssetResourceLoader`-based rewrite in Phase 2.
- **Telemetry** (spec §9): `start` on play, `progress` every 30 s and on close, `complete` at end,
  `error` on failure; anonymous `sessionUUID` per player instance; `quality` is `null` (ABR picks
  the rendition, the client does not know it). Failures are ignored.

## Local networking

Debug builds allow plain-HTTP loopback (`NSAllowsLocalNetworking`) so the simulator can reach the
API and MinIO on the Mac. Release builds use HTTPS hosts and do not need it.
