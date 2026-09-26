(() => {
  'use strict';

  const SPEC_MSG = 'cfc-flow-spec';
  const SPEC_REQ = 'cfc-flow-spec-request';

  let cached;

  async function getSpec() {
    if (cached !== undefined) return cached;
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'getSpec' });
      cached = reply?.ok && reply.spec ? reply.spec : null;
    } catch {
      cached = null;
    }
    return cached;
  }

  function publish(spec) {
    window.postMessage({ type: SPEC_MSG, spec }, location.origin);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== SPEC_REQ) return;
    getSpec().then(publish);
  });

  getSpec().then(publish);
})();
