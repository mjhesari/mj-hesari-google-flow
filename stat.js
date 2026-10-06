const DIAGNOSTIC_ATTRIBUTES = [
    'data-flow-local-diagnostic',
    'data-stitch-local-diagnostic',
  ],
  MAX_STATE_LENGTH = 80;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'status') return;
  let diagnostic;
  try {
    for (const attr of DIAGNOSTIC_ATTRIBUTES) {
      const raw = document.documentElement.getAttribute(attr);
      if (!raw) continue;
      diagnostic = JSON.parse(raw);
      break;
    }
  } catch {
    /* ignore broken diagnostic payload */
  }
  sendResponse({
    state:
      typeof diagnostic?.state === 'string'
        ? diagnostic.state.slice(0, MAX_STATE_LENGTH)
        : 'not-loaded',
    applied: diagnostic?.applied > 0,
  });
});
