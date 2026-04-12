// Adapter for Claude — formats a context bundle as an Anthropic-style system prompt with XML tags.

function renderSection(lines, tag, items) {
  if (items && items.length > 0) {
    lines.push(`<${tag}>`);
    items.forEach((item) => lines.push(`  - ${item}`));
    lines.push(`</${tag}>`);
    lines.push('');
  }
}

export function formatForClaude(contextBundle) {
  const lines = [
    '<context_bridge>',
    'The following is structured context extracted from a previous AI conversation. Use it to maintain continuity.',
    '',
  ];

  if (contextBundle.summary) {
    lines.push('<summary>');
    lines.push(contextBundle.summary);
    lines.push('</summary>');
    lines.push('');
  }

  renderSection(lines, 'goals', contextBundle.goals);
  renderSection(lines, 'constraints', contextBundle.constraints);
  renderSection(lines, 'decisions', contextBundle.decisions);
  renderSection(lines, 'tech_stack', contextBundle.tech_stack);
  renderSection(lines, 'architecture', contextBundle.architecture);
  renderSection(lines, 'timeline', contextBundle.timeline);
  renderSection(lines, 'open_questions', contextBundle.open_questions);
  renderSection(lines, 'assumptions', contextBundle.assumptions);
  renderSection(lines, 'key_entities', contextBundle.key_entities);

  lines.push('</context_bridge>');
  lines.push('');
  lines.push('You now have full context from a previous session. Confirm you understand the project state, then ask what the user wants to work on next. Pay special attention to items marked [CRITICAL] and any open questions.');

  return lines.join('\n');
}
