# Orbb for Chrome

A Manifest V3 Chrome extension that runs in Chrome’s side panel and saves content to Orbb using `@orbb/orbit-sdk`.

## Features

* QR-based sign-in authorized through the Orbb mobile app
* One-click capture of the current page
* Drag-and-drop capture for links, images, audio, text, and files up to 10 MB
* Context-menu capture for pages, links, images, and selected text
* Import of Instagram saved posts and folders, Reddit saved posts, and X bookmarks
* Manual and scheduled collection
* URL normalization and local duplicate detection before saving

## Build

Requires Node.js 22.13.0 or later.

```bash
git clone https://github.com/OWNER/orbb-chrome-extension.git
cd orbb-chrome-extension
npm ci
npm run check
```

The built extension is written to `dist/`.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the generated `dist/` directory.

Pin Orbb or select its toolbar icon to open the side panel.

## Social imports

Orbb does not request or store passwords for Instagram, Reddit, or X. When an import is started, the extension uses the session already signed in through Chrome.

Social-site access is optional. The extension requests the relevant host permission only when the user enables or starts an import for that provider.

Chrome must be running for scheduled imports to execute. Because provider websites and interfaces can change, social-import compatibility may occasionally require updates.

## Privacy and security

Authentication is approved through the Orbb mobile app. The extension does not collect or store an Orbb password.

The extension’s manifest contains a public key used to keep the unpacked extension ID stable. It is not a private signing key and must not be treated as proof that a client is an official build.

Disconnecting removes the locally stored Orbb credential and requests server-side revocation.

For more information, see:

* [`PRIVACY.md`](PRIVACY.md) for data collection, transmission, retention, and permissions
* [`SECURITY.md`](SECURITY.md) for vulnerability reporting and security details
* [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for bundled dependency notices

## Development

```bash
npm run dev
npm run typecheck
npm test
npm run build
npm run build:chrome
```

## License

This project is available under the MIT License.
