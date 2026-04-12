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

const SYSTEM_PROMPT = `You are a context extraction engine. Given a conversation between a user and an AI assistant, extract the following into structured JSON only. No prose, no markdown, only raw JSON.

Extract:
- summary: A string. 2-3 sentence overview of what the conversation is about and what was accomplished.
- goals: Array of strings. What the user is trying to build or achieve.
- constraints: Array of strings. Technical, business, time, or resource limits mentioned.
- decisions: Array of strings. Choices already made (tech stack, architecture, approach).
- assumptions: Array of strings. Things taken for granted that have not been validated.
- tech_stack: Array of strings. Languages, frameworks, databases, libraries, APIs, and services mentioned or chosen.
- architecture: Array of strings. Architectural patterns, system layers, deployment targets, data flow, and infrastructure decisions.
- open_questions: Array of strings. Unresolved questions, unknowns, or things that still need to be figured out.
- key_entities: Array of strings. People, teams, systems, services, products, or domain concepts mentioned by name.

Rules:
- Each array item max 50 words.
- Only extract explicitly stated or strongly implied information.
- If nothing found for a category, return an empty array. If no summary, return empty string.
- Output only valid JSON matching: { "summary": "", "goals": [], "constraints": [], "decisions": [], "assumptions": [], "tech_stack": [], "architecture": [], "open_questions": [], "key_entities": [] }`;

const STRICT_RETRY_PROMPT = `You previously returned invalid JSON. Output ONLY a raw JSON object with these exact keys: summary (string), goals (array), constraints (array), decisions (array), assumptions (array), tech_stack (array), architecture (array), open_questions (array), key_entities (array). No markdown, no prose, no code fences.`;

// ENG-02 — score each item 1–5 by importance heuristic.
function scoreItem(text, category) {
  let score = 3;
  const t = text.toLowerCase();

  if (category === 'goals') {
    if (t.includes('must') || t.includes('critical') || t.includes('primary')) score = 5;
    else if (t.includes('should') || t.includes('need')) score = 4;
    else if (t.includes('could') || t.includes('might') || t.includes('optional')) score = 2;
  }
  if (category === 'constraints') {
    if (t.includes('cannot') || t.includes('must not') || t.includes('deadline') || t.includes('budget')) score = 5;
    else if (t.includes('limited') || t.includes('only') || t.includes('restrict')) score = 4;
    else if (t.includes('prefer') || t.includes('ideally')) score = 2;
  }
  if (category === 'decisions') {
    if (t.includes('decided') || t.includes('chosen') || t.includes('using') || t.includes('will use')) score = 5;
    else if (t.includes('going with') || t.includes('picked')) score = 4;
    else if (t.includes('considering') || t.includes('maybe')) score = 2;
  }
  if (category === 'assumptions') {
    score = 2;
  }
  if (category === 'tech_stack') {
    if (t.includes('primary') || t.includes('core') || t.includes('main')) score = 5;
    else if (t.includes('considering') || t.includes('evaluating')) score = 3;
    else score = 4;
  }
  if (category === 'architecture') {
    if (t.includes('must') || t.includes('required')) score = 5;
    else if (t.includes('possibly') || t.includes('might')) score = 3;
    else score = 4;
  }
  if (category === 'open_questions') {
    if (t.includes('blocking') || t.includes('critical') || t.includes('urgent')) score = 5;
    else if (t.includes('minor') || t.includes('nice to have')) score = 2;
    else score = 3;
  }
  if (category === 'key_entities') {
    score = 3;
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
    max_tokens: 2048,
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
  };
}
