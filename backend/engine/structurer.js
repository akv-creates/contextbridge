// Structures raw conversation messages into detailed context categories via Groq (free).

import Groq from 'groq-sdk';

// Lazy client — instantiated on first call so dotenv has already run.
let client;
function getClient() {
  if (!client) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY not configured');
    }
    client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return client;
}

const SYSTEM_PROMPT = `You are a precise context extraction engine. Given a conversation between a user and an AI assistant, extract structured JSON. No prose, no markdown, only raw JSON.

CRITICAL RULES:
- Only extract information that is CONFIRMED or DECIDED — never extract items that are merely asked about, suggested as possibilities, or listed as options.
- If the assistant asks "are you using React, Vue, or Angular?" and the user has NOT confirmed any of them, do NOT add any to tech_stack.
- Distinguish between DECIDED ("we will use X", "let's go with X") vs MENTIONED/DISCUSSED ("you could use X", "consider X") vs QUESTIONED ("are you using X?").
- For decisions: only include choices that were explicitly agreed upon or confirmed by the user.
- For tech_stack: only include technologies that are confirmed as part of the project, not alternatives that were merely discussed.
- For assumptions: include things taken for granted without explicit validation AND important caveats/limitations mentioned (e.g., "IndexedDB has a 50MB limit").

Extract these categories:
- summary: String. 2-3 sentences covering what was discussed, the current state, and any important caveats or tradeoffs mentioned.
- goals: Array of strings. What the user is trying to build or achieve. Include specific measurable targets (e.g., "support 500 concurrent users").
- constraints: Array of strings. Technical, business, time, resource, or team limits. Include team size, deadlines, budgets, and quantitative limits discussed.
- decisions: Array of strings. Choices CONFIRMED by the user — include the reasoning when given (e.g., "Using Yjs over OT because CRDTs handle concurrent edits better"). Format: "WHAT — WHY" when reasoning exists.
- assumptions: Array of strings. Things taken for granted, plus important caveats and limitations mentioned.
- tech_stack: Array of strings. CONFIRMED languages, frameworks, libraries, APIs, and services. Include specific packages mentioned (e.g., "y-indexeddb" not just "Yjs"). Do NOT include technologies only mentioned as questions or alternatives.
- architecture: Array of strings. System design decisions, deployment targets, data flow patterns, scaling strategies, and infrastructure choices.
- open_questions: Array of strings. Unresolved questions, unknowns, and things that still need to be figured out.
- key_entities: Array of strings. People, teams, external systems, products, or domain concepts mentioned — NOT technology names (those belong in tech_stack).
- timeline: Array of strings. Any milestones, phases, deadlines, or prioritization order discussed (e.g., "Month 1: online editing, Month 2: cursors, Month 3: offline").

Rules:
- Each array item max 60 words.
- Be specific — include numbers, names, and rationale when available.
- If nothing found for a category, return an empty array. If no summary, return empty string.
- Output only valid JSON matching: { "summary": "", "goals": [], "constraints": [], "decisions": [], "assumptions": [], "tech_stack": [], "architecture": [], "open_questions": [], "key_entities": [], "timeline": [] }`;

const STRICT_RETRY_PROMPT = `You previously returned invalid JSON. Output ONLY a raw JSON object with these exact keys: summary (string), goals (array), constraints (array), decisions (array), assumptions (array), tech_stack (array), architecture (array), open_questions (array), key_entities (array), timeline (array). No markdown, no prose, no code fences.`;

// ENG-02 — score each item 1–5 by importance heuristic.
function scoreItem(text, category) {
  let score = 3;
  const t = text.toLowerCase();

  if (category === 'goals') {
    if (t.includes('must') || t.includes('critical') || t.includes('primary') || /\d+/.test(t)) score = 5;
    else if (t.includes('should') || t.includes('need')) score = 4;
    else if (t.includes('could') || t.includes('might') || t.includes('optional')) score = 2;
  }
  if (category === 'constraints') {
    if (t.includes('cannot') || t.includes('must not') || t.includes('deadline') || t.includes('budget') || /\$[\d,]+/.test(t) || /\d+\s*(month|week|day|developer|team)/.test(t)) score = 5;
    else if (t.includes('limited') || t.includes('only') || t.includes('restrict')) score = 4;
    else if (t.includes('prefer') || t.includes('ideally')) score = 2;
  }
  if (category === 'decisions') {
    // Decisions with reasoning ("because", "since", "—") are higher value.
    if (t.includes('because') || t.includes('since') || t.includes(' — ') || t.includes('over')) score = 5;
    else if (t.includes('decided') || t.includes('chosen') || t.includes('using') || t.includes('will use') || t.includes('go with')) score = 4;
    else if (t.includes('considering') || t.includes('maybe')) score = 2;
  }
  if (category === 'assumptions') {
    if (t.includes('limit') || t.includes('caveat') || t.includes('risk') || t.includes('unexpected') || t.includes('warning')) score = 4;
    else score = 2;
  }
  if (category === 'tech_stack') {
    if (t.includes('primary') || t.includes('core') || t.includes('main')) score = 5;
    else if (t.includes('considering') || t.includes('evaluating')) score = 2;
    else score = 4;
  }
  if (category === 'architecture') {
    if (t.includes('must') || t.includes('required') || t.includes('scaling') || t.includes('horizontal')) score = 5;
    else if (t.includes('possibly') || t.includes('might')) score = 3;
    else score = 4;
  }
  if (category === 'open_questions') {
    if (t.includes('blocking') || t.includes('critical') || t.includes('urgent') || t.includes('how to')) score = 5;
    else if (t.includes('minor') || t.includes('nice to have')) score = 2;
    else score = 3;
  }
  if (category === 'key_entities') {
    score = 3;
  }
  if (category === 'timeline') {
    if (t.includes('deadline') || t.includes('month 1') || t.includes('phase 1') || t.includes('first')) score = 5;
    else score = 4;
  }

  return Math.max(1, Math.min(5, score));
}

function scoreItems(items, category) {
  return items.map((text) => ({ text, importance: scoreItem(text, category) }));
}

function buildUserMessage(messages) {
  const formatted = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');
  return `Here is the conversation to analyse:\n\n${formatted}`;
}

async function callGroq(systemPrompt, userContent) {
  const response = await getClient().chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.1,
    max_tokens: 3000,
  });
  return response.choices[0]?.message?.content || '';
}

function safeArray(val) {
  return Array.isArray(val) ? val : [];
}

function safeString(val) {
  return typeof val === 'string' ? val : '';
}

export async function structureContext(messages) {
  if (!process.env.GROQ_API_KEY) {
    console.error('[structurer] GROQ_API_KEY is not set');
    throw new Error('GROQ_API_KEY not configured');
  }

  const userContent = buildUserMessage(messages);

  let raw = await callGroq(SYSTEM_PROMPT, userContent);

  let parsed;
  try {
    const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('[structurer] JSON parse failed on first attempt, retrying');
    raw = await callGroq(STRICT_RETRY_PROMPT, userContent);
    try {
      const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('[structurer] JSON parse failed on retry');
      throw new Error('Failed to parse structured context from LLM: ' + err.message);
    }
  }

  const summary = safeString(parsed.summary);
  const goals = safeArray(parsed.goals);
  const constraints = safeArray(parsed.constraints);
  const decisions = safeArray(parsed.decisions);
  const assumptions = safeArray(parsed.assumptions);
  const tech_stack = safeArray(parsed.tech_stack);
  const architecture = safeArray(parsed.architecture);
  const open_questions = safeArray(parsed.open_questions);
  const key_entities = safeArray(parsed.key_entities);
  const timeline = safeArray(parsed.timeline);

  const title = goals[0] ? goals[0].slice(0, 60) : 'Untitled Session';

  return {
    title,
    summary,
    goals: scoreItems(goals, 'goals'),
    constraints: scoreItems(constraints, 'constraints'),
    decisions: scoreItems(decisions, 'decisions'),
    assumptions: scoreItems(assumptions, 'assumptions'),
    tech_stack: scoreItems(tech_stack, 'tech_stack'),
    architecture: scoreItems(architecture, 'architecture'),
    open_questions: scoreItems(open_questions, 'open_questions'),
    key_entities: scoreItems(key_entities, 'key_entities'),
    timeline: scoreItems(timeline, 'timeline'),
  };
}
