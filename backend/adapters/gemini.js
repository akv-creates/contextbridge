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
    'You are continuing work on an existing project. Here is the full context from previous sessions:',
    '',
  ];

  if (contextBundle.summary) {
    parts.push('**Summary:**');
    parts.push(contextBundle.summary);
    parts.push('');
  }

  renderSection(parts, 'Goals', contextBundle.goals);
  renderSection(parts, 'Constraints', contextBundle.constraints);
  renderSection(parts, 'Decisions', contextBundle.decisions);
  renderSection(parts, 'Tech Stack', contextBundle.tech_stack);
  renderSection(parts, 'Architecture', contextBundle.architecture);
  renderSection(parts, 'Open Questions', contextBundle.open_questions);
  renderSection(parts, 'Key Entities', contextBundle.key_entities);
  renderSection(parts, 'Assumptions', contextBundle.assumptions);

  parts.push('Acknowledge you have read the context and ask the user what they want to work on next.');

  const text = parts.join('\n');

  // Return Gemini contents[] structure with role 'user' as the system turn.
  return JSON.stringify([
    {
      role: 'user',
      parts: [{ text }],
    },
  ]);
}
