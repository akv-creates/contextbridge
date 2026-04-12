// Adapter for Gemini — formats a context bundle for Google Generative AI API contents[] structure.

function renderSection(parts, header, items) {
  if (items && items.length > 0) {
    parts.push(`**${header}:**`);
    items.forEach((item) => parts.push(`- ${item}`));
    parts.push('');
  }
}

export function formatForGemini(contextBundle) {
  const parts = [
    '## Context Bridge: Previous Session Context',
    'The following is structured context extracted from a previous AI conversation. Use it to maintain continuity.',
    '',
  ];

  if (contextBundle.summary) {
    parts.push('**Summary:**');
    parts.push(contextBundle.summary);
    parts.push('');
  }

  renderSection(parts, 'Goals', contextBundle.goals);
  renderSection(parts, 'Constraints', contextBundle.constraints);
  renderSection(parts, 'Decisions Made', contextBundle.decisions);
  renderSection(parts, 'Tech Stack', contextBundle.tech_stack);
  renderSection(parts, 'Architecture', contextBundle.architecture);
  renderSection(parts, 'Timeline', contextBundle.timeline);
  renderSection(parts, 'Open Questions', contextBundle.open_questions);
  renderSection(parts, 'Assumptions & Caveats', contextBundle.assumptions);
  renderSection(parts, 'Key Entities', contextBundle.key_entities);

  parts.push('---');
  parts.push('You now have full context from a previous session. Confirm you understand the project state, then ask what the user wants to work on next.');

  const text = parts.join('\n');

  return JSON.stringify([
    {
      role: 'user',
      parts: [{ text }],
    },
  ]);
}
