# Smart Cursor

Smart Cursor is a Chrome extension that scans a webpage, identifies the main sections, and walks a user through it with a calm guided tour and plain-language explanations.

## Local-first setup (recommended)

This project is built for a zero-prompt local demo path. The Gemini key is stored in a local `.env` file, generated into `config.local.js` at build time, and then used by the extension without any popup setup UI.

1. Copy `.env.example` to `.env`.
2. Put your Gemini API key in `.env`.
3. Run `npm run build` once.
4. Open `chrome://extensions/` in Google Chrome.
5. Turn on Developer mode.
6. Click Load unpacked and select this folder.
7. Open the extension on any normal website and use the tour, Ask Smart Cursor, or page-orientation features.

Get a free Gemini key here: https://aistudio.google.com/

## Optional relay backend

The `relay/` folder remains available for anyone who wants to run a hosted Cloudflare Worker version instead of the local build-based flow. It is not required for the default local demo path.

## Notes

- `.env` is git-ignored and must never be committed.
- `config.local.js` is generated from `.env` and is also git-ignored.
- The popup does not show a key prompt; it is intentionally built for immediate use after the build step.
