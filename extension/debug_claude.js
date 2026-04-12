// Temporary debug script — run via popup console or executeScript to inspect Claude's DOM.
(async () => {
  // Find all data-testid attributes on the page
  const testIds = new Set();
  document.querySelectorAll('[data-testid]').forEach(el => testIds.add(el.getAttribute('data-testid')));

  // Find classes containing key words
  const keywords = ['message', 'turn', 'human', 'user', 'assistant', 'claude', 'chat', 'conversation', 'prose', 'response'];
  const matchedClasses = new Set();
  document.querySelectorAll('*').forEach(el => {
    if (el.classList) {
      el.classList.forEach(cls => {
        for (const kw of keywords) {
          if (cls.toLowerCase().includes(kw)) matchedClasses.add(cls);
        }
      });
    }
  });

  // Find contenteditable elements (for inject)
  const editables = [];
  document.querySelectorAll('[contenteditable="true"]').forEach(el => {
    editables.push({
      tag: el.tagName,
      className: el.className.slice(0, 100),
      id: el.id,
    });
  });

  return {
    testIds: Array.from(testIds).sort(),
    matchedClasses: Array.from(matchedClasses).sort(),
    editables,
    totalElements: document.querySelectorAll('*').length,
  };
})();
