# ConteXetu — Chrome Web Store Listing Kit

Everything needed to publish. Character limits noted per field.

---

## Name (max 45 chars)

```
ConteXetu — Portable AI Memory
```

## Short description (max 132 chars)

```
Never re-explain your project to an AI again. Capture context from ChatGPT & Claude, redact PII on-device, inject anywhere.
```

## Category

Productivity → Tools (same category as competitors; ranks on "AI context", "AI memory", "prompt" keywords)

## Detailed description

```
Stop re-explaining your project every time you open a new AI chat.

ConteXetu captures the working context of any ChatGPT or Claude conversation — goals, decisions, constraints, tech stack, open questions — and turns it into a portable memory you can inject into ANY model. Switch from ChatGPT to Claude to Gemini to a local Ollama model and pick up exactly where you left off.

■ WHY CONTEXETU

Every AI chat starts from zero. You paste the same background, re-state the same decisions, and burn tokens (and patience) rebuilding context the model had yesterday. ConteXetu makes context a first-class, portable asset.

■ CORE FEATURES

✦ One-click capture — grab a full ChatGPT or Gemini conversation from the toolbar, keyboard shortcut (Alt+Shift+C), or the floating on-page bridge. Claude and any other chat via smart paste parsing.

✦ Structured, not just saved — conversations are distilled into 9 categories (goals, decisions, constraints, tech stack, architecture, assumptions, open questions, key entities, timeline), each scored by importance. Not a wall of text — a working brief.

✦ Inject anywhere — one click formats your context for Claude (XML), ChatGPT, Gemini, or Ollama, each in the style that model responds to best. Or export universal Markdown for Claude Projects, Custom GPTs, Gems, and NotebookLM.

✦ Smart Slice — ask a question first, and ConteXetu retrieves only the relevant pieces from ALL your past sessions, trimmed to a token budget. See exactly how many tokens (and how much money) you saved.

✦ Privacy by architecture — emails, phone numbers, API keys, names, and addresses are detected and redacted ON YOUR DEVICE before anything is sent for structuring. The redaction map never leaves your machine and is never stored. If the local privacy gate is offline, capture is blocked — never silently leaked.

✦ Capture from documents — drop in a .docx or .pptx (or capture a Google Doc/Slides) and extract its context the same way.

✦ Merge & version sessions — combine related sessions into one master context; every update is versioned.

✦ Claude Desktop / Claude Code native — ships with an MCP server, so Claude can save and load your context directly. No paste at all.

■ HOW IT'S DIFFERENT

Other context-transfer extensions store your raw conversations in their cloud. ConteXetu is self-hosted: YOUR database, YOUR machine, on-device PII redaction, open architecture. Your AI memory shouldn't belong to someone else's startup.

■ GETTING STARTED

ConteXetu pairs with a lightweight local backend (Node.js or Docker, 2-minute setup — guide included). Your data stays in your own PostgreSQL database.

Capture once. Reuse everywhere. Never start from zero again.
```

## Keywords / search terms

ai memory, context transfer, chatgpt to claude, ai context, prompt manager, conversation export, ai productivity, chatgpt memory, claude memory, cross-model, portable context, token saver

---

## Screenshot plan (1280×800, 5 max — order matters)

1. **Hero**: popup open over a ChatGPT tab, one session captured, caption overlay: "Capture once. Reuse everywhere."
2. **Inject modal**: target picker showing Claude/ChatGPT/Gemini/Ollama, caption: "Every model speaks a different dialect — we format for each."
3. **Smart Slice**: query typed + savings chip visible, caption: "Ask first. Inject only what's relevant. Watch the tokens saved."
4. **Privacy**: diagram-style frame (on-device redaction → cloud), caption: "PII redacted on your device. The map never leaves."
5. **Context preview**: 9-category structured view, caption: "Not a transcript dump — a working brief."

Promo tile (440×280): black background, X-mark logo left, "Never start a chat from zero again." right.

---

## Positioning vs. Capsule Hub by Tilantra (internal, do not publish)

| Dimension | Capsule Hub (3.8★, 80K users) | ConteXetu |
|---|---|---|
| Storage | Their cloud | Self-hosted, your DB |
| Privacy | Unstated | On-device PII redaction, fail-closed |
| Context format | Raw "capsules" | 9-category structured brief, importance-scored |
| Retrieval | Manual pick | Smart Slice: semantic, token-budgeted, savings shown |
| Claude Desktop/Code | — | Native MCP server |
| Documents | Attachment transfer | .docx/.pptx/GDoc extraction through same pipeline |
| Per-model formatting | Generic paste | Adapter per model (XML for Claude, etc.) |

Their weak spots per reviews (3.8★): reliability of capture, cloud dependency. Our listing leans on: privacy-first, structured-not-raw, measurable savings.

Gaps to close (roadmap, honest): they support DeepSeek capture and team folders — we now capture ChatGPT + Gemini natively (Claude via paste — its DOM resists scraping), but remain single-user. Ship shared vaults before making team claims. NOTE: Gemini scraping/injection selectors (`user-query`/`model-response`, `div.ql-editor`) are written but not yet verified against the live site — test on gemini.google.com before shipping.

---

## Publishing checklist

- [ ] `manifest.json` version bumped (now 1.1.0)
- [ ] Zip `extension/` (exclude STORE_LISTING.md, x-mark.svg optional)
- [ ] 5 screenshots at 1280×800
- [ ] Promo tile 440×280
- [ ] Privacy policy URL (PRIVACY.md → host on site; Web Store requires a URL, not a file)
- [ ] Justify permissions in the listing: `downloads` (export files), `notifications` (capture confirmations), `identity` (Google Docs OAuth), host permissions (capture on chatgpt.com/claude.ai/gemini.google.com/docs.google.com only)
- [ ] Single-purpose statement: "Captures and transfers AI conversation context between AI chat services."
