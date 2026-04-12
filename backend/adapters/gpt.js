// Adapter for GPT — formats a context bundle as a plain prose system message with dash section headers.

function renderSection(lines, header, items) {
  if (items && items.length > 0) {
    lines.push(`--- ${header} ---`);
    items.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
  }
}

export function formatForGPT(contextBundle) {
  const lines = [
    'You are continuing work on an existing project. Here is the full context from previous sessions:',
    '',
  ];

  if (contextBundle.summary) {
    lines.push('--- Summary ---');
    lines.push(contextBundle.summary);
    lines.push('');
  }

  renderSection(lines, 'Goals', contextBundle.goals);
  renderSection(lines, 'Constraints', contextBundle.constraints);
  renderSection(lines, 'Decisions', contextBundle.decisions);
  renderSection(lines, 'Tech Stack', contextBundle.tech_stack);
  renderSection(lines, 'Architecture', contextBundle.architecture);
  renderSection(lines, 'Open Questions', contextBundle.open_questions);
  renderSection(lines, 'Key Entities', contextBundle.key_entities);
  renderSection(lines, 'Assumptions', contextBundle.assumptions);

  lines.push('Acknowledge you have read the context and ask the user what they want to work on next.');

  return lines.join('\n');
}
