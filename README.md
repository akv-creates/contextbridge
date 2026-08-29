# ContextBridge

Capture AI conversation context (ChatGPT, Claude, Google Docs/Slides, uploaded `.docx`/`.pptx`) and carry it into a different AI tool — without copy-paste, and without sending raw personal data to the cloud.

ContextBridge runs **entirely on infrastructure you control**. There's no central server: you run the backend locally (or on your own machine/server), and a local AI model redacts personal data *before* anything reaches a cloud LLM. See [PRIVACY.md](./PRIVACY.md) for the full data-flow breakdown.

## Architecture

```
extension/    Chrome extension (Manifest V3) — popup, floating in-page bridge, background worker
backend/      Node.js/Express API — privacy gate, structuring, storage
```

- **Privacy gate** (`backend/engine/local-gate.js`): scans captured text for PII (emails, phones, API keys, names) using a local [Ollama](https://ollama.com) model, redacts it, then sends only the redacted text to Groq for structuring.
- **Storage**: PostgreSQL, running locally.
- **Google Docs/Slides capture**: uses the official Docs/Slides REST APIs via OAuth (read-only), with a download+manual-upload fallback if OAuth isn't configured.

## Setup

You need three things running: **Ollama** (local privacy gate), **PostgreSQL**, and the **backend**. Then load the **extension** in Chrome.

### 1. Ollama (required — the privacy gate refuses to forward data to the cloud if this isn't running)

```bash
# Install: https://ollama.com/download
ollama pull llama3.2:3b
ollama serve   # usually runs automatically after install
```

### 2. Backend + database

**Option A — Docker Compose (recommended):**
```bash
cd backend
cp .env.example .env
# Edit .env: set GROQ_API_KEY (free tier at https://console.groq.com)
cd ..
docker compose up
```
Docker Compose automatically points the backend at the right internal hostnames for Postgres and your host's Ollama — you don't need to edit those two values in `.env` for this path.

**Option B — run directly on your machine:**
```bash
cd backend
cp .env.example .env
# Edit .env: set GROQ_API_KEY, and point DATABASE_URL at a Postgres instance you've started
npm install
npm start
```

Verify it's up: `curl http://localhost:3001/health` should return `{"status":"ok", ..., "db":"connected"}`.

### 3. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder
4. Pin the ContextBridge icon to your toolbar

### 4. (Optional) Google Docs/Slides automatic capture

By default, capturing a Google Doc/Slides downloads the file and asks you to drop it into the popup's upload box. To make this fully automatic via Google's API instead:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable the **Google Docs API** and **Google Slides API**
3. Configure the OAuth consent screen (External, Testing mode is fine for personal/small-team use — add your Google account under **Test users**)
4. Create an **OAuth Client ID** (type: Chrome Extension), using your extension's ID from `chrome://extensions`
5. Paste the resulting client ID into `extension/manifest.json` → `oauth2.client_id`
6. Reload the extension

Without this setup, Google Docs/Slides capture still works via the download+upload fallback — this step only removes the manual step.

## Testing

```bash
cd backend
node test/qa-suite.mjs   # requires the backend + Ollama running
```

## Configuration reference

| File | Purpose |
|---|---|
| `backend/.env` | Backend secrets/config — `GROQ_API_KEY` required, `DATABASE_URL`, `OLLAMA_*` |
| `extension/manifest.json` | `oauth2.client_id` for Google API capture (optional) |
| Extension settings page | Point the extension at a non-default backend URL |


