// Universal markdown adapter — portable across every LLM chat input
// (ChatGPT, Gemini, Perplexity, Ollama, local models) and usable as a
// knowledge-file upload (Claude Projects, Custom GPTs, Gemini Gems, NotebookLM).
// Importance markers from the assembler ([CRITICAL] / [low]) are rendered as
// bold inline tags so the reader LLM notices them.

const SECTIONS = [
  { key: 'goals',          heading: 'Goals' },
  { key: 'constraints',    heading: 'Constraints' },
  { key: 'decisions',      heading: 'Decisions' },
  { key: 'tech_stack',     heading: 'Tech stack' },
  { key: 'architecture',   heading: 'Architecture' },
  { key: 'timeline',       heading: 'Timeline' },
  { key: 'open_questions', heading: 'Open questions' },
  { key: 'assumptions',    heading: 'Assumptions' },
  { key: 'key_entities',   heading: 'Key entities' },
];

function renderItem(raw) {
  // Promote the textual importance markers the assembler produced into
  // real markdown emphasis so they survive pasting into chat inputs.
  if (typeof raw !== 'string') raw = String(raw);
  if (raw.startsWith('[CRITICAL] ')) {
    return '- **[CRITICAL]** ' + raw.slice('[CRITICAL] '.length);
  }
  if (raw.startsWith('[low] ')) {
    return '- *[low]* ' + raw.slice('[low] '.length);
  }
  return '- ' + raw;
}

function renderSection(lines, heading, items) {
  if (!items || items.length === 0) return;
  lines.push('## ' + heading);
  items.forEach(function (item) {
    lines.push(renderItem(item));
  });
  lines.push('');
}

export function formatForMarkdown(contextBundle) {
  const lines = [
    '# Previous Conversation Context',
    '',
    '> Structured context from a previous AI session. Use it to maintain continuity with the user.',
    '',
  ];

  if (contextBundle.summary) {
    lines.push('## Summary');
    lines.push(contextBundle.summary);
    lines.push('');
  }

  SECTIONS.forEach(function (s) {
    renderSection(lines, s.heading, contextBundle[s.key]);
  });

  lines.push('---');
  lines.push('');
  lines.push('*You now have full context from a previous session. Confirm you understand the project state, then ask what the user wants to work on next. Pay special attention to items marked **[CRITICAL]** and any open questions.*');
  lines.push('');

  return lines.join('\n');
}
