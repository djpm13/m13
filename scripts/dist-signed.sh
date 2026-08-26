#!/usr/bin/env bash
# Build, sign, notarize and staple M13 in one shot.
# Loads Apple ID credentials from build/notarize.env (gitignored), then runs
# electron-builder (which signs the .app + notarizes/staples it), then notarizes
# and staples the .dmg files themselves — a step electron-builder skips, without
# which a downloaded DMG throws an "Apple cannot check it" Gatekeeper warning.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f build/notarize.env ]; then
  echo "ERROR: build/notarize.env not found."
  echo "Copy build/notarize.env.example to build/notarize.env and fill in your"
  echo "Apple ID, app-specific password, and team ID first."
  exit 1
fi

# shellcheck disable=SC1091
source build/notarize.env

# Fail early with a clear message if any credential is missing.
: "${APPLE_ID:?APPLE_ID not set (your Apple Developer email)}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD not set (format abcd-efgh-ijkl-mnop)}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set (should be 57PW79YX2K)}"

echo "Signing identity : Developer ID Application: Pravesh Mirpuri (57PW79YX2K)"
echo "Notarize as      : $APPLE_ID  (team $APPLE_TEAM_ID)"
echo "Building + notarizing… (notarization can take several minutes)"
echo

npx electron-builder "$@"

# electron-builder notarizes/staples the .app but NOT the .dmg wrapper, so staple
# each DMG here. Submitting an already-notarized payload is quick and idempotent.
echo
shopt -s nullglob
dmgs=(dist/*.dmg)
if [ ${#dmgs[@]} -eq 0 ]; then
  echo "No .dmg files in dist/ to staple (skipping)."
else
  DMG_IDENTITY="Developer ID Application: Pravesh Mirpuri (57PW79YX2K)"
  for dmg in "${dmgs[@]}"; do
    if xcrun stapler validate "$dmg" >/dev/null 2>&1 \
       && codesign -dv "$dmg" >/dev/null 2>&1; then
      echo "Already signed + stapled: $dmg"
      continue
    fi
    # Sign the DMG itself (electron-builder leaves it unsigned), then notarize
    # and staple. Sign BEFORE notarizing — signing changes the hash the ticket
    # is keyed to, so notarizing must happen on the final signed bytes.
    echo "Code-signing DMG: $dmg"
    codesign --force --sign "$DMG_IDENTITY" --timestamp "$dmg"
    echo "Notarizing DMG: $dmg"
    xcrun notarytool submit "$dmg" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
    xcrun stapler staple "$dmg"
    xcrun stapler validate "$dmg"
  done
  echo "All DMGs signed + notarized + stapled."
fi
