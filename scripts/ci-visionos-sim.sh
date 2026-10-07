#!/usr/bin/env bash
# Ensures a booted visionOS simulator exists on the runner and exports its UDID
# as SIM_UDID (into $GITHUB_ENV when running under Actions). Prefers a device the
# image already ships; otherwise creates one, trying each Vision device type
# against the newest xrOS runtime until the pair is accepted.
set -euo pipefail
if ! xcrun simctl list runtimes | grep -qi visionos; then
  sudo xcodebuild -downloadPlatform visionOS
fi
udid=$(xcrun simctl list devices available -j | python3 -c '
import json, sys
devs = json.load(sys.stdin)["devices"]
for rt, ds in devs.items():
    if "xrOS" in rt or "visionOS" in rt:
        for d in ds:
            if d.get("isAvailable"):
                print(d["udid"]); sys.exit(0)')
if [ -z "$udid" ]; then
  runtime=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; rs=[r for r in json.load(sys.stdin)["runtimes"] if r["platform"]=="xrOS" and r["isAvailable"]]; rs.sort(key=lambda r: r["version"]); print(rs[-1]["identifier"])')
  for devtype in $(xcrun simctl list devicetypes -j | python3 -c 'import json,sys; print(" ".join(d["identifier"] for d in json.load(sys.stdin)["devicetypes"] if "Vision" in d["name"]))'); do
    echo "trying $devtype with $runtime"
    if udid=$(xcrun simctl create "Apple Vision Pro CI" "$devtype" "$runtime" 2>/dev/null); then break; fi
    udid=""
  done
fi
[ -n "$udid" ] || { echo "no visionOS simulator could be created"; xcrun simctl list; exit 1; }
echo "udid=$udid"
xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b
xcrun simctl list devices | grep "$udid"
if [ -n "${GITHUB_ENV:-}" ]; then echo "SIM_UDID=$udid" >> "$GITHUB_ENV"; fi
