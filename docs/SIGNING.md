# M13 — macOS Signing & Notarization Checklist (v1.13.0+)

Why this exists: v1.13.0 bundles a **static ffmpeg binary** (`node_modules/ffmpeg-static/ffmpeg`,
unpacked from the asar — see `asarUnpack` in package.json) that powers 432hz file conversion.
The app builds with `hardenedRuntime: true` and ships as a DMG outside the App Store. On a
customer's Mac, **Gatekeeper will refuse to spawn that binary unless it is signed with the same
Developer ID and notarized with the app**. In dev it works because local binaries are trusted —
a downloaded DMG is not. Do NOT ship the 432 update before completing this checklist.

## 0. One-time setup (after Apple Developer Program enrollment, US$99/yr)

1. Enroll: https://developer.apple.com/programs/enroll/
2. In Xcode (Settings → Accounts) or developer.apple.com, create a
   **Developer ID Application** certificate and install it in the login keychain.
   Verify: `security find-identity -v -p codesigning` → shows `Developer ID Application: <Name> (TEAMID)`.
3. Create an **app-specific password** for notarization: https://appleid.apple.com → Sign-In & Security.
4. Export env vars for electron-builder (put in `~/.zshrc` or CI secrets, never in the repo):
   ```sh
   export APPLE_ID="you@example.com"                # your Apple Developer account email
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="XXXXXXXXXX"                # from developer.apple.com membership page
   ```
   electron-builder ≥26 picks these up and notarizes automatically when they're present
   (add `"notarize": true` under `build.mac` in package.json to be explicit).

## 1. Build

```sh
cd /Users/pints/M13        # production copy, after merging the dev changes
npm run dist               # electron-builder → DMG + ZIP, signs + notarizes
```

Watch the log for: `signing file=… identity=Developer ID Application` lines that include
`app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg` — electron-builder signs every
Mach-O it finds under asarUnpack, but this is the line that proves it.

## 2. Verify signatures (on the build machine)

```sh
APP="dist/mac-arm64/M13.app"   # and repeat for x64

# whole app: valid + hardened runtime
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Authority|flags"   # expect runtime flag + Developer ID chain
codesign --verify --deep --strict "$APP" && echo APP-SIG-OK

# the ffmpeg binary specifically (the launch blocker if missed)
FF="$APP/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg"
codesign -dv --verbose=2 "$FF" 2>&1 | grep Authority                # expect the same Developer ID
codesign --verify --strict "$FF" && echo FFMPEG-SIG-OK

# notarization ticket stapled to the DMG
xcrun stapler validate dist/M13-*.dmg && echo STAPLE-OK

# Gatekeeper's own verdict
spctl -a -vv -t install dist/M13-*.dmg                              # expect "accepted · Notarized Developer ID"
```

## 3. Clean-Mac test (the one that actually counts)

On a Mac (or fresh macOS VM / second user account) that has **never run dev builds**:

1. Download the DMG via a browser (this sets the quarantine attribute — copying via USB does not;
   or fake it: `xattr -w com.apple.quarantine "0083;$(printf %x $(date +%s));Safari;" M13.dmg`).
2. Install to /Applications, launch. Expect: opens with no Gatekeeper block, no right-click-Open workaround.
3. **432 conversion smoke test** — the reason this doc exists:
   - Open a folder with one MP3 and one AIFF/WAV.
   - Right-click each → Convert Tuning → 432 → Convert.
   - PASS: new `(432hz)` files appear and play. FAIL ("Conversion failed: ffmpeg …" or a
     "cannot be opened" OS dialog): ffmpeg wasn't signed/notarized — recheck step 2.
4. Quick regression pass: playback, Ambient mode + EQ, tuning toggle, Clean Up preview (no Apply),
   Fetch Artwork, auto-update check.

## 4. Known gotchas

- **Both arches**: the DMG builds arm64 + x64 — run step 2 for each; notarization covers both if
  submitted together, but verify each binary's signature.
- **ffmpeg-static updates**: any `npm install` that replaces the ffmpeg binary invalidates its
  signature — signing happens at build time so this is fine, but never hand-copy an unsigned
  ffmpeg into an already-built app.
- **entitlements**: current `build/entitlements.mac.plist` already includes `disable-library-validation`
  and JIT allowances; ffmpeg needs nothing extra. The child process inherits no entitlements —
  it only needs its own valid Developer ID signature + notarization, which the steps above cover.
- **Timing**: notarization usually takes 1–10 min; `xcrun notarytool history --apple-id "$APPLE_ID" ...`
  shows submission status if a build seems stuck.
