// Adapter for Ollama — formats a context bundle for local Ollama /api/chat with minimal token footprint.

function renderSection(lines, header, items) {
  if (items && items.length > 0) {
    lines.push(`${header}:`);
    items.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
  }
}

export function formatForOllama(contextBundle) {
  const lines = [
    'You are continuing work on an existing project. Here is the full context from previous sessions:',
    '',
  ];

  if (contextBundle.summary) {
    lines.push('SUMMARY:');
    lines.push(contextBundle.summary);
    lines.push('');
  }

  renderSection(lines, 'GOALS', contextBundle.goals);
  renderSection(lines, 'CONSTRAINTS', contextBundle.constraints);
  renderSection(lines, 'DECISIONS', contextBundle.decisions);
  renderSection(lines, 'TECH STACK', contextBundle.tech_stack);
  renderSection(lines, 'ARCHITECTURE', contextBundle.architecture);
  renderSection(lines, 'OPEN QUESTIONS', contextBundle.open_questions);
  renderSection(lines, 'KEY ENTITIES', contextBundle.key_entities);
  renderSection(lines, 'ASSUMPTIONS', contextBundle.assumptions);

  lines.push('Acknowledge you have read the context and ask the user what they want to work on next.');

  return lines.join('\n');
}
