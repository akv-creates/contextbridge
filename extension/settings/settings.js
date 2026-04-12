// Settings page controller — loads and persists backend configuration to chrome.storage.local.

function init() {
  const backendInput = document.getElementById('backend-url');
  const apiKeyInput = document.getElementById('api-key');
  const saveBtn = document.getElementById('save-btn');
  const toast = document.getElementById('toast');

  // Load existing settings.
  chrome.storage.local.get(['BACKEND_URL', 'API_KEY'], (result) => {
    if (result.BACKEND_URL) backendInput.value = result.BACKEND_URL;
    if (result.API_KEY) apiKeyInput.value = result.API_KEY;
  });

  saveBtn.addEventListener('click', () => {
    const backendUrl = backendInput.value.trim() || 'http://localhost:3001';
    const apiKey = apiKeyInput.value.trim();

    chrome.storage.local.set({ BACKEND_URL: backendUrl, API_KEY: apiKey }, () => {
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 2500);
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
