(() => {
  'use strict';

  const DIAGNOSTIC_ATTR = 'data-flow-local-diagnostic';
  const LOG_TAG = '[MJ Hesari Flow]';
  const SPEC_MSG = 'cfc-flow-spec';
  const SPEC_REQ = 'cfc-flow-spec-request';
  const ACCESS_DENIED_MSG = 'cfc-flow-access-denied';
  const BLOCKED_PATHS = ['/unavailable', '/unsupported-country'];
  const STRIP_PARAMS = ['pli'];
  const ACCESS_DENIED_RE = /don'?t have access to Flow/i;
  const BATCH_PATH = '/_/AiSandboxAngularFrontend/data/batchexecute';

  const FALLBACK_SPEC = {
    origin: 'https://flow.google.com',
    path: BATCH_PATH,
    rpcids: 'cPZSdc',
    tag: 'wrb.fr',
    flagIndex: 30,
    minLength: 32,
  };

  function adjustFrameLength(lines, index, oldLine, newLine) {
    const declaredLen = Number(lines[index - 1]);
    if (!Number.isFinite(declaredLen)) return;
    const utf8Len = (s) => new TextEncoder().encode(s).length;
    const lenFns = [utf8Len, (s) => s.length];
    const cleanOld = oldLine.replace(/\r$/, '');
    const lenFn = lenFns.find((fn) =>
      [0, 1, 2].includes(declaredLen - fn(cleanOld)),
    );
    if (!lenFn) throw new Error('Unexpected frame length');
    lines[index - 1] = String(declaredLen + lenFn(newLine) - lenFn(cleanOld));
  }

  function flipFalseFlags(payload, forceIndex) {
    const flipped = [];
    if (
      Number.isInteger(forceIndex) &&
      forceIndex >= 0 &&
      forceIndex < payload.length &&
      (payload[forceIndex] === null || typeof payload[forceIndex] === 'boolean')
    ) {
      if (payload[forceIndex] !== true) {
        flipped.push(forceIndex);
        payload[forceIndex] = true;
      }
    }
    for (let i = 0; i < payload.length; i++) {
      if (payload[i] === false) {
        payload[i] = true;
        if (!flipped.includes(i)) flipped.push(i);
      }
    }
    return flipped;
  }

  /**
   * Patch config-like batchexecute frames.
   * Primary RPC (cPZSdc) flips flagIndex + all false booleans.
   * Other large array RPCs also flip false booleans — entitlement may live there.
   */
  function patchResponse(body, spec) {
    const lines = body.split('\n');
    let before;
    let hits = 0;
    const allFlipped = [];

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('[[')) continue;

      let chunks;
      try {
        chunks = JSON.parse(lines[i]);
      } catch {
        continue;
      }

      let changed = false;
      for (const chunk of chunks) {
        if (!Array.isArray(chunk) || chunk[0] !== spec.tag) continue;
        if (typeof chunk[2] !== 'string') continue;

        let payload;
        try {
          payload = JSON.parse(chunk[2]);
        } catch {
          continue;
        }
        if (!Array.isArray(payload) || payload.length < Math.min(8, spec.minLength)) {
          continue;
        }

        const isPrimary = chunk[1] === spec.rpcids;
        if (isPrimary) {
          if (
            payload.length < spec.minLength ||
            (payload[spec.flagIndex] !== null &&
              typeof payload[spec.flagIndex] !== 'boolean')
          ) {
            throw new Error('Unexpected config schema');
          }
          before = payload[spec.flagIndex];
        }

        // Only touch payloads that look like feature-flag bags (have bool/null slots).
        const boolish = payload.filter(
          (v) => v === null || typeof v === 'boolean',
        ).length;
        if (!isPrimary && boolish < 3) continue;

        const flipped = flipFalseFlags(
          payload,
          isPrimary ? spec.flagIndex : -1,
        );
        if (!flipped.length && !isPrimary) continue;

        if (isPrimary && payload[spec.flagIndex] !== true) {
          payload[spec.flagIndex] = true;
          if (!flipped.includes(spec.flagIndex)) flipped.push(spec.flagIndex);
        }

        chunk[2] = JSON.stringify(payload);
        hits++;
        changed = true;
        for (const idx of flipped) {
          allFlipped.push(`${chunk[1]}:${idx}`);
        }
      }

      if (!changed) continue;

      const oldLine = lines[i];
      const newLine = JSON.stringify(chunks);
      adjustFrameLength(lines, i, oldLine, newLine);
      lines[i] = newLine;
    }

    return {
      body: lines.join('\n'),
      before,
      hits,
      flipped: allFlipped,
      unchanged: hits === 0,
    };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { patch: (body) => patchResponse(body, FALLBACK_SPEC) };
    return;
  }

  if (window.__flowLocalDiagnostic) return;

  const diagnostic = (window.__flowLocalDiagnostic = {
    state: 'awaiting-spec',
    applied: 0,
    flipped: [],
  });

  function setState(state, extra) {
    Object.assign(diagnostic, { state }, extra || {});
    console.info(LOG_TAG, JSON.stringify(diagnostic));
    const write = () => {
      document.documentElement.setAttribute(
        DIAGNOSTIC_ATTR,
        JSON.stringify(diagnostic),
      );
    };
    if (document.documentElement) write();
    else document.addEventListener('DOMContentLoaded', write, { once: true });
  }

  function isValidSpec(spec) {
    return (
      !!spec &&
      typeof spec === 'object' &&
      typeof spec.path === 'string' &&
      spec.path.startsWith('/') &&
      typeof spec.rpcids === 'string' &&
      spec.rpcids.length > 0 &&
      typeof spec.tag === 'string' &&
      spec.tag.length > 0 &&
      Number.isInteger(spec.flagIndex) &&
      spec.flagIndex >= 0 &&
      Number.isInteger(spec.minLength) &&
      spec.minLength > spec.flagIndex
    );
  }

  function sanitizeUrl(urlLike) {
    try {
      const url = new URL(urlLike, location.href);
      let changed = false;

      for (const blocked of BLOCKED_PATHS) {
        if (url.pathname === blocked || url.pathname.endsWith(blocked)) {
          url.pathname =
            url.pathname.replace(new RegExp(blocked + '/?$'), '/') || '/';
          changed = true;
        }
      }

      for (const key of STRIP_PARAMS) {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key);
          changed = true;
        }
      }

      return changed ? url : null;
    } catch {
      return null;
    }
  }

  function escapeBadRoute() {
    const next = sanitizeUrl(location.href);
    if (!next || next.href === location.href) return;
    history.replaceState(
      history.state,
      '',
      next.pathname + next.search + next.hash,
    );
  }

  function installHistoryGuards() {
    const wrap = (method) => {
      const original = history[method];
      history[method] = function (state, title, url) {
        if (typeof url === 'string') {
          const next = sanitizeUrl(url);
          if (next) url = next.pathname + next.search + next.hash;
        }
        return original.call(this, state, title, url);
      };
    };
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', escapeBadRoute);
    escapeBadRoute();
  }

  function installLocationGuards() {
    const rewrite = (urlLike) => {
      const next = sanitizeUrl(urlLike);
      return next ? next.pathname + next.search + next.hash : urlLike;
    };
    try {
      const proto = Location.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'href');
      if (desc?.set && desc.configurable) {
        Object.defineProperty(proto, 'href', {
          configurable: true,
          enumerable: desc.enumerable,
          get: desc.get,
          set(value) {
            return desc.set.call(this, rewrite(String(value)));
          },
        });
      }
      for (const method of ['assign', 'replace']) {
        const original = proto[method];
        if (typeof original !== 'function') continue;
        proto[method] = function (url) {
          return original.call(this, rewrite(String(url)));
        };
      }
    } catch {
      /* locked Location */
    }
  }

  let accessDeniedReported = false;
  function reportAccessDenied(reason) {
    if (accessDeniedReported) return;
    accessDeniedReported = true;
    setState('access-denied', { accessDenied: reason });
    // Soft signal only — hard cookie wipe often causes the one-shot / broken loop.
    window.postMessage(
      {
        type: ACCESS_DENIED_MSG,
        reason,
        href: location.href,
        applied: diagnostic.applied,
        flipped: diagnostic.flipped,
      },
      location.origin,
    );
  }

  function installAccessDeniedWatcher() {
    const check = () => {
      const text = document.body?.innerText || '';
      if (!ACCESS_DENIED_RE.test(text)) return;
      reportAccessDenied(
        location.search.includes('pli=') ? 'pli-route' : 'access-copy',
      );
    };
    const start = () => {
      check();
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      // Keep watching longer — denial often appears after late RPCs.
      setTimeout(() => observer.disconnect(), 120000);
    };
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  function matchesBatchExecute(url) {
    try {
      const parsed = new URL(url, location.href);
      return (
        parsed.origin === location.origin &&
        (parsed.pathname === BATCH_PATH ||
          parsed.pathname.includes('/data/batchexecute'))
      );
    } catch {
      return false;
    }
  }

  let spec = FALLBACK_SPEC;
  const trackedXhr = new WeakMap();
  const patchedBodies = new WeakMap();

  function applyPatch(value) {
    const result = patchResponse(value, spec);
    if (!result.unchanged) {
      diagnostic.applied++;
      diagnostic.flipped = (diagnostic.flipped || [])
        .concat(result.flipped)
        .slice(-40);
      setState('applied', {
        before: result.before,
        hits: result.hits,
        flipped: diagnostic.flipped,
      });
    }
    return result.unchanged ? value : result.body;
  }

  // --- XHR ---
  const xhrProto = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;

  xhrProto.open = function (method, url, ...rest) {
    trackedXhr.set(this, matchesBatchExecute(url));
    patchedBodies.delete(this);
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };

  for (const prop of ['responseText', 'response']) {
    const descriptor = Object.getOwnPropertyDescriptor(xhrProto, prop);
    if (!descriptor?.get || !descriptor.configurable) continue;

    Object.defineProperty(xhrProto, prop, {
      ...descriptor,
      get() {
        const value = Reflect.apply(descriptor.get, this, []);
        if (!trackedXhr.get(this) || typeof value !== 'string') return value;
        if (this.readyState === 3) return '';
        if (this.readyState !== 4) return value;

        if (!patchedBodies.has(this)) {
          try {
            patchedBodies.set(this, applyPatch(value));
          } catch (err) {
            patchedBodies.set(this, value);
            setState('schema mismatch — unchanged', {
              error: String(err?.message || err),
            });
          }
        }
        return patchedBodies.get(this);
      },
    });
  }

  // --- fetch ---
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;

    const shouldPatch = matchesBatchExecute(url);
    const response = await originalFetch(input, init);
    if (!shouldPatch) return response;

    try {
      const text = await response.clone().text();
      const body = applyPatch(text);
      if (body === text) return response;
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (err) {
      setState('schema mismatch — unchanged', {
        error: String(err?.message || err),
      });
      return response;
    }
  };

  let tries = 0;
  const armWith = (next, state = 'armed') => {
    if (diagnostic.applied > 0) return;
    spec = next;
    setState(state);
  };

  const requestSpec = () => {
    if (tries >= 40) return;
    tries++;
    window.postMessage({ type: SPEC_REQ }, location.origin);
    setTimeout(requestSpec, 500);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== SPEC_MSG) return;
    if (!isValidSpec(data.spec)) {
      armWith(FALLBACK_SPEC, 'armed');
      return;
    }
    armWith(data.spec);
  });

  installHistoryGuards();
  installLocationGuards();
  installAccessDeniedWatcher();
  setState('armed');
  requestSpec();
})();
