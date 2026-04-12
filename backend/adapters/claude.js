// Adapter for Claude — formats a context bundle as an Anthropic-style system prompt with XML tags.

function renderSection(lines, tag, items) {
  if (items && items.length > 0) {
    lines.push(`<${tag}>`);
    items.forEach((item) => lines.push(`  ${item}`));
    lines.push(`</${tag}>`);
    lines.push('');
  }
}

export function formatForClaude(contextBundle) {
  const lines = [
    'You are continuing work on an existing project. Here is the full context from previous sessions:',
    '',
  ];

  if (contextBundle.summary) {
    lines.push('<summary>');
    lines.push(`  ${contextBundle.summary}`);
    lines.push('</summary>');
    lines.push('');
  }

  renderSection(lines, 'goals', contextBundle.goals);
  renderSection(lines, 'constraints', contextBundle.constraints);
  renderSection(lines, 'decisions', contextBundle.decisions);
  renderSection(lines, 'tech_stack', contextBundle.tech_stack);
  renderSection(lines, 'architecture', contextBundle.architecture);
  renderSection(lines, 'open_questions', contextBundle.open_questions);
  renderSection(lines, 'key_entities', contextBundle.key_entities);
  renderSection(lines, 'assumptions', contextBundle.assumptions);

  lines.push('Acknowledge you have read the context and ask the user what they want to work on next.');

  return lines.join('\n');
}
