#!/usr/bin/env bash
# Ensures a booted visionOS simulator named "Apple Vision Pro CI" exists on the
# runner (downloading the platform first if the image ships without it).
set -euo pipefail
if ! xcrun simctl list runtimes | grep -qi visionos; then
  sudo xcodebuild -downloadPlatform visionOS
fi
runtime=$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; rs=[r for r in json.load(sys.stdin)["runtimes"] if r["platform"]=="xrOS" and r["isAvailable"]]; rs.sort(key=lambda r: r["version"]); print(rs[-1]["identifier"])')
devtype=$(xcrun simctl list devicetypes -j | python3 -c 'import json,sys; ds=[d for d in json.load(sys.stdin)["devicetypes"] if "Vision" in d["name"]]; print(ds[-1]["identifier"])')
echo "runtime=$runtime devicetype=$devtype"
udid=$(xcrun simctl list devices -j | python3 -c 'import json,sys
for rt, devs in json.load(sys.stdin)["devices"].items():
    for d in devs:
        if d["name"] == "Apple Vision Pro CI": print(d["udid"]); sys.exit(0)')
if [ -z "$udid" ]; then
  udid=$(xcrun simctl create "Apple Vision Pro CI" "$devtype" "$runtime")
fi
echo "udid=$udid"
xcrun simctl boot "$udid" || true
xcrun simctl bootstatus "$udid" -b
xcrun simctl list devices | grep "Apple Vision Pro CI"
