// Adapter for GPT — formats a context bundle as a system message with dash section headers.

function renderSection(lines, header, items) {
  if (items && items.length > 0) {
    lines.push(`--- ${header} ---`);
    items.forEach((item) => lines.push(`- ${item}`));
    lines.push('');
  }
}

export function formatForGPT(contextBundle) {
  const lines = [
    '=== CONTEXT BRIDGE: Previous Session Context ===',
    'The following is structured context extracted from a previous AI conversation. Use it to maintain continuity.',
    '',
  ];

  if (contextBundle.summary) {
    lines.push('--- Summary ---');
    lines.push(contextBundle.summary);
    lines.push('');
  }

  renderSection(lines, 'Goals', contextBundle.goals);
  renderSection(lines, 'Constraints', contextBundle.constraints);
  renderSection(lines, 'Decisions Made', contextBundle.decisions);
  renderSection(lines, 'Tech Stack', contextBundle.tech_stack);
  renderSection(lines, 'Architecture', contextBundle.architecture);
  renderSection(lines, 'Timeline', contextBundle.timeline);
  renderSection(lines, 'Open Questions', contextBundle.open_questions);
  renderSection(lines, 'Assumptions & Caveats', contextBundle.assumptions);
  renderSection(lines, 'Key Entities', contextBundle.key_entities);

  lines.push('=== END CONTEXT ===');
  lines.push('');
  lines.push('You now have full context from a previous session. Confirm you understand the project state, then ask what the user wants to work on next. Pay special attention to items marked [CRITICAL] and any open questions.');

  return lines.join('\n');
}
