(() => {
  'use strict';

  const SPEC_MSG = 'cfc-flow-spec';
  const SPEC_REQ = 'cfc-flow-spec-request';
  const ACCESS_DENIED_MSG = 'cfc-flow-access-denied';

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
    if (event.data?.type === SPEC_REQ) {
      getSpec().then(publish);
      return;
    }
    if (event.data?.type === ACCESS_DENIED_MSG) {
      // Do NOT auto-wipe site data here. That created the
      // "works once → clear → works → refresh broken" loop.
      // Log for the panel / console instead.
      console.warn(
        '[MJ Hesari Flow] access denied observed',
        event.data.reason,
        'applied=',
        event.data.applied,
        'flipped=',
        event.data.flipped,
      );
    }
  });

  getSpec().then(publish);
})();
