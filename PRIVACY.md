# ContextBridge Privacy Policy

_Last updated: 2026-06-25_

ContextBridge is a self-hosted browser extension. There is no ContextBridge server operated by us that your data passes through — when you install ContextBridge, you run your own backend (via `docker compose up` or `npm start`), and all data described below stays on infrastructure you control.

## What ContextBridge does

ContextBridge captures conversation context from AI chat tools (ChatGPT, Claude) and documents (Google Docs, Google Slides, uploaded `.docx`/`.pptx` files), so you can carry that context into a different AI tool without manually copying and pasting.

## What data is processed, and where

| Step | What happens | Where it happens |
|---|---|---|
| Capture | The extension reads the conversation/document text from the page you're viewing | Your browser |
| Privacy scan | The captured text is scanned for personal data (emails, phone numbers, API keys, names) using a local AI model (Ollama) | Your own machine — never sent anywhere for this step |
| Redaction | Detected personal data is replaced with placeholder tokens before anything leaves your machine | Your own machine |
| Structuring | The **redacted** text is sent to Groq's cloud API to extract a structured summary (goals, decisions, tech stack, etc.) | Groq, a third-party LLM provider (only redacted text is sent) |
| Storage | The structured result is saved to your own PostgreSQL database | Your own backend, on infrastructure you control |
| Google Docs/Slides | If you use the Google Docs/Slides capture feature, the extension requests a read-only OAuth token (via Chrome's built-in identity API) and fetches document content directly from Google's API | Google's API, then processed as above |

**We (the ContextBridge developers) never receive, see, or have access to any of your captured content, documents, or conversation data.** There is no central ContextBridge server.

## Google OAuth scopes

ContextBridge requests two read-only Google OAuth scopes:
- `documents.readonly` — to read the content of a Google Doc you explicitly choose to capture
- `presentations.readonly` — to read the content of a Google Slides deck you explicitly choose to capture

These scopes are used only at the moment you click the capture button on a specific document. ContextBridge does not browse, list, or access any other files in your Google account, and does not request write access.

## Local processing

The PII-detection step runs on a local AI model (Ollama) on your own machine. This is a deliberate design choice: personal data is identified and redacted *before* any cloud API call, so emails, phone numbers, names, and similar details never reach Groq or any other third party in their original form.

## Third parties

- **Groq** receives only the redacted text of captured conversations/documents, for the sole purpose of generating a structured summary. See [Groq's privacy policy](https://groq.com/privacy-policy/).
- **Google** receives OAuth requests scoped as described above, when you use the Docs/Slides capture feature. See [Google's privacy policy](https://policies.google.com/privacy).
- No other third party receives any data processed by ContextBridge.

## Data retention and deletion

All captured data is stored in the PostgreSQL database you run yourself. You control retention entirely — delete sessions from the extension's popup, or stop/delete your own database at any time.

## Contact

Questions about this policy can be directed to [your contact email/GitHub issues link].
