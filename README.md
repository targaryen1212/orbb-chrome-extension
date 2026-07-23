# Orbb for Chrome

A Manifest V3 Chrome extension that runs in the side panel and saves into Orbb
through `@orbb/orbit-sdk`.

## What it supports

- QR login authorized by the Orbb mobile app. The extension receives a 30-day,
  write-only V2 token without storing an Orbb password.
- One-click capture of the current page.
- Drag and drop for links, images, audio, text, and files up to 10 MB.
- Context-menu capture for pages, links, images, and selected quotes on desktop.
- Instagram saved posts and folders, Reddit saved posts, and X bookmarks.
- Manual or scheduled collection every 30 minutes, hourly, every 6 hours, or
  daily.
- URL normalization and local deduplication before an item is sent to Orbit.

## Build

Requires Node.js `>=22.13.0`.

```bash
git clone https://github.com/OWNER/orbb-chrome-extension.git
cd orbb-chrome-extension
npm ci
npm run check
```

The build writes the standalone extension to `dist/`.

## Load in Chrome

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**,
and select the generated `dist/` directory.

Pin Orbb or click its toolbar icon to open the side panel.

## Backend requirement

The extension connects through the Orbit SDK to the Orbit service at
`https://api.orbb.app/v2`. The service provides QR authentication, authenticated
bookmark writes, duplicate lookup, and private media upload/finalization.

The Orbit service must allow the securely origin-bound
`chrome-extension://<extension-id>` scheme.

The `key` in `manifest.json` is a public identity key that keeps the unpacked
extension ID stable. It is not a private Chrome Web Store signing key and must
not be treated by a server as proof that a client is an official build.
Authorization still depends on explicit QR approval, scoped tokens, revocation,
and server-side rate limits.

Extension saves intentionally omit a category so V2 analysis can classify each
item from its captured content rather than storing a generic bookmark category.

## How social collection works

Orbb does not ask for or store social passwords. A sync opens each provider's
saved-items page in an inactive Chrome tab and uses the session already logged
into that site. Instagram collection uses its logged-in saved-post web endpoint
so folder names can be preserved; Reddit and X are read from their rendered
saved/bookmark pages.

The inactive tab is closed after collection. Chrome must be running for
scheduled alarms to execute. Provider web endpoints and page markup can change,
so the collectors are isolated in `src/background.ts` for maintenance. Each
provider pass has a four-minute safety budget so a changing or unusually large
feed cannot hold the background worker indefinitely.

Social-site access is optional. Chrome requests the relevant host permission
only when the user enables or starts an import for Instagram, Reddit, or X.

## Privacy and security

The Orbb credential is stored in Chrome local storage, restricted to trusted
extension contexts, and never returned in side-panel snapshots. Disconnecting
removes the active local credential and attempts server-side revocation.

See [PRIVACY.md](PRIVACY.md) for collection, transmission, retention, and
permission details. Report vulnerabilities according to
[SECURITY.md](SECURITY.md). Bundled dependency notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Repository and releases

Generated `dist/`, ZIP archives, vendored package tarballs, screenshots, local
dependencies, and environment files are intentionally excluded from source
control. Releases should be built from a tagged commit with `npm ci` followed
by `npm run check`, and must include the project license, privacy policy, and
third-party notices.

This directory must be published as its own repository. Do not change the
visibility of the larger `NextraHome` product repository.

## Useful commands

```bash
npm run dev
npm run typecheck
npm test
npm run build
npm run build:chrome
```

## License

This project is open source under the [MIT License](LICENSE).
