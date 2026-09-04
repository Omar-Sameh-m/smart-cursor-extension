# Smart Cursor

Smart Cursor helps people who find modern websites confusing — especially older adults or anyone with reduced working memory — by pointing at and plainly explaining the most important actions on a page. It runs as a Chrome extension and delivers short, staged guided tours with optional voice narration so users can see and hear what matters without being overwhelmed.

## Why this exists
Many assistive or AI tools only describe pages in text. Smart Cursor points at real page elements, explains one idea at a time, and paces information so users can follow along. The result is a low-friction, human-friendly walkthrough that reduces cognitive load compared to a dense text-only explanation.

## Core features
- Guided, two-level tours that highlight sections and individual items
- Risk warnings for potentially irreversible actions, with a calm reassurance line
- Plain-language jargon pills that define unfamiliar terms inline
- "Ask a question" that finds and points to answers on the page
- Voice narration: high-quality Neural2 audio via an optional relay, with automatic browser-TTS fallback

## Local setup (quick, exact steps)
This project is intentionally local-first. The extension requires a Gemini API key to generate tours; follow these steps to run locally:

1. Get a (free) Gemini API key: https://aistudio.google.com/
2. Copy the example env and add your key:

```bash
cp .env.example .env
# Edit .env and set:
# GEMINI_API_KEY=your_real_key_here
```

3. Generate the local runtime config:

```bash
npm run build
```

4. Load the extension in Chrome:

- Open `chrome://extensions/` in Chrome
- Enable Developer mode (top-right)
- Click "Load unpacked" and select this project folder
- Open any regular website and click the Smart Cursor toolbar icon to start

Notes:
- `npm run build` runs the small `build-config.js` script which reads `.env` and writes `config.local.js`. Both `.env` and `config.local.js` are ignored by git and must never be committed.
- Neural2 voice narration requires the optional relay (see below). If the relay is not running or available, the extension will fall back to the browser's built-in TTS (window.speechSynthesis).

## Optional: Neural2 TTS / relay
A small Cloudflare Worker relay is included in `relay/` to convert text → Neural2 audio and return base64 MP3 to the extension. The relay is optional:

- Use the relay if you want higher-quality Neural2 narration (the extension will call `http://localhost:3000/api/speak` by default).
- If you don't run the relay, Smart Cursor will still function and will use the browser TTS fallback for narration.

The `relay/` folder contains a `wrangler.toml` and the worker source; it is provided as an optional deployment path and is not required for local demos.

## Project structure
A short overview of the important files and folders:

```
/ (project root)
├─ background.js          # Service worker: handles Gemini API calls and message routing
├─ build-config.js        # Build helper: reads .env → writes config.local.js
├─ config.local.js        # Generated at build time (contains GEMINI_API_KEY) — gitignored
├─ .env.example           # Example env to copy from
├─ popup/                 # Popup UI, tour orchestration and staged reveal logic
├─ content/               # Content script injected into pages: highlights, tooltips, plays audio
├─ relay/                 # Optional Cloudflare Worker: tour generation + TTS endpoints
├─ manifest.json          # Chrome extension manifest (MV3, module background)
└─ README.md
```

## Known limitations
- Does not work on canvas-based applications (e.g., Figma prototypes) where page elements are not standard DOM nodes.
- Cannot access cross-origin iframe contents due to browser security restrictions.
- The extension never clicks or navigates on the user's behalf — it points to and explains controls but does not perform actions for the user.
- Neural2 audio requires a running relay or a compatible audio generation endpoint; without it, the extension will use browser TTS.

## Troubleshooting
- Missing Gemini key / configuration problems:
  - Ensure you copied `.env.example` → `.env` and set `GEMINI_API_KEY`.
  - Re-run `npm run build` after editing `.env` and then reload the extension in `chrome://extensions/`.
- If narration falls back to browser speech:
  - Either accept the fallback, or run/deploy the optional relay in `relay/` to provide Neural2 audio at `http://localhost:3000/api/speak`.
- If the popup can't inject overlays on a page: avoid `chrome://` pages, extension pages, and other internal Chrome pages; try a normal public website.

## License
This project is released under the MIT License. See the `LICENSE` file for details.

---

If you want, the next changes that would help a public demo are a short CONTRIBUTING.md, an example screenshot or GIF (in /docs), and a simple LICENSE file (MIT). I can add any of those now.