(() => {
  'use strict';

  const SPEC_MSG = 'cfc-flow-spec';
  const SPEC_REQ = 'cfc-flow-spec-request';
  const ACCESS_DENIED_MSG = 'cfc-flow-access-denied';
  const IS_STITCH = location.hostname === 'stitch.withgoogle.com';

  let cached;

  function getSpec() {
    if (IS_STITCH) return Promise.resolve(null);
    if (cached !== undefined) return Promise.resolve(cached);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (spec) => {
        if (settled) return;
        settled = true;
        cached = spec;
        resolve(spec);
      };
      try {
        chrome.runtime.sendMessage({ type: 'getSpec' }, (reply) => {
          // Reading lastError marks the port failure as handled. Otherwise
          // Chrome lists this file under the extension errors.
          if (chrome.runtime.lastError || !reply?.ok || !reply.spec) {
            finish(null);
            return;
          }
          finish(reply.spec);
        });
      } catch {
        finish(null);
      }
    });
  }

  function publish(spec) {
    try {
      window.postMessage({ type: SPEC_MSG, spec }, location.origin);
    } catch {
      /* origin cannot receive the spec */
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === 'cfc-stitch-apply' && event.data.id) {
      const id = String(event.data.id);
      let ok = false;
      try {
        const holder = document.getElementById('mj-gate-' + id);
        const el = holder?.content?.querySelector('script');
        if (!el) throw new Error('missing gate script');
        try {
          el.text = event.data.code;
        } catch {
          const policy = window.trustedTypes?.createPolicy('mj-hesari#stitch', {
            createScript: (input) => String(input),
          });
          el.text = policy.createScript(event.data.code);
        }
        ok = true;
      } catch {
        ok = false;
      }
      window.postMessage({ type: 'cfc-stitch-applied', id, ok }, location.origin);
      return;
    }
    if (event.data?.type === SPEC_REQ) {
      if (IS_STITCH) return;
      getSpec().then(publish);
      return;
    }
    if (event.data?.type === ACCESS_DENIED_MSG) {
      // Do NOT auto-wipe site data here. That created the
      // "works once → clear → works → refresh broken" loop.
      // Log for the panel / console instead.
      console.warn(
        IS_STITCH
          ? '[MJ Hesari Stitch] access denied observed'
          : '[MJ Hesari Flow] access denied observed',
        event.data.reason,
        'applied=',
        event.data.applied,
        'flipped=',
        event.data.flipped,
      );
    }
  });

  if (!IS_STITCH) getSpec().then(publish);
})();
