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
