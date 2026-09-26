(() => {
  'use strict';

  const DIAGNOSTIC_ATTR = 'data-flow-local-diagnostic';
  const LOG_TAG = '[MJ Hesari Flow]';
  const SPEC_MSG = 'cfc-flow-spec';
  const SPEC_REQ = 'cfc-flow-spec-request';
  const BLOCKED_PATHS = ['/unavailable', '/unsupported-country'];

  const FALLBACK_SPEC = {
    origin: 'https://flow.google.com',
    path: '/_/AiSandboxAngularFrontend/data/batchexecute',
    rpcids: 'cPZSdc',
    tag: 'wrb.fr',
    flagIndex: 30,
    minLength: 32,
  };

  function patchResponse(body, spec) {
    const lines = body.split('\n');
    let before;
    let hits = 0;

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
        if (!Array.isArray(chunk) || chunk[0] !== spec.tag || chunk[1] !== spec.rpcids) {
          continue;
        }

        const payload = JSON.parse(chunk[2]);
        if (
          !Array.isArray(payload) ||
          payload.length < spec.minLength ||
          (payload[spec.flagIndex] !== null && typeof payload[spec.flagIndex] !== 'boolean')
        ) {
          throw new Error('Unexpected config schema');
        }

        before = payload[spec.flagIndex];
        payload[spec.flagIndex] = true;
        hits++;
        chunk[2] = JSON.stringify(payload);
        changed = true;
      }

      if (!changed) continue;

      const oldLine = lines[i].replace(/\r$/, '');
      const declaredLen = Number(lines[i - 1]);
      const utf8Len = (s) => new TextEncoder().encode(s).length;
      const lenFns = [utf8Len, (s) => s.length];
      const lenFn = lenFns.find((fn) => [0, 1, 2].includes(declaredLen - fn(oldLine)));
      if (!lenFn) throw new Error('Unexpected frame length');

      const newLine = JSON.stringify(chunks);
      lines[i - 1] = String(declaredLen + lenFn(newLine) - lenFn(oldLine));
      lines[i] = newLine;
    }

    if (hits !== 1) throw new Error('Expected one config response');
    return { body: lines.join('\n'), before };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { patch: (body) => patchResponse(body, FALLBACK_SPEC) };
    return;
  }

  if (window.__flowLocalDiagnostic) return;

  const diagnostic = (window.__flowLocalDiagnostic = {
    state: 'awaiting-spec',
    applied: 0,
  });

  function setState(state, before) {
    Object.assign(diagnostic, { state, before });
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

  function stripBlockedPath(urlLike) {
    try {
      const url = new URL(urlLike, location.href);
      for (const blocked of BLOCKED_PATHS) {
        if (url.pathname === blocked || url.pathname.endsWith(blocked)) {
          url.pathname = url.pathname.replace(new RegExp(blocked + '/?$'), '/') || '/';
          return url;
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function escapeBlockedRoute() {
    const next = stripBlockedPath(location.href);
    if (!next || next.href === location.href) return;
    history.replaceState(history.state, '', next.pathname + next.search + next.hash);
  }

  function installHistoryGuards() {
    const wrap = (method) => {
      const original = history[method];
      history[method] = function (state, title, url) {
        if (typeof url === 'string') {
          const next = stripBlockedPath(url);
          if (next) url = next.pathname + next.search + next.hash;
        }
        return original.call(this, state, title, url);
      };
    };
    wrap('pushState');
    wrap('replaceState');

    window.addEventListener('popstate', escapeBlockedRoute);
    escapeBlockedRoute();
  }

  function matchesTarget(url, spec) {
    try {
      const parsed = new URL(url, location.href);
      if (spec) {
        return (
          parsed.origin === location.origin &&
          parsed.pathname === spec.path &&
          parsed.searchParams.get('rpcids') === spec.rpcids
        );
      }
      return (
        parsed.origin === location.origin &&
        parsed.pathname.includes('/data/batchexecute')
      );
    } catch {
      return false;
    }
  }

  let spec = null;
  let allowPassthrough = false;
  const trackedXhr = new WeakMap();
  const patchedBodies = new WeakMap();

  // --- XHR hook ---
  const xhrProto = XMLHttpRequest.prototype;
  const originalOpen = xhrProto.open;

  xhrProto.open = function (method, url, ...rest) {
    trackedXhr.set(this, matchesTarget(url, spec));
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

        if (!spec) {
          diagnostic.heldForSpec = true;
          return this.readyState === 4 && allowPassthrough ? value : '';
        }

        if (this.readyState === 3) {
          diagnostic.heldPartial = true;
          return '';
        }
        if (this.readyState !== 4) return value;

        if (!patchedBodies.has(this)) {
          try {
            const result = patchResponse(value, spec);
            patchedBodies.set(this, result.body);
            diagnostic.applied++;
            setState('applied', result.before);
          } catch {
            patchedBodies.set(this, value);
            setState('schema mismatch — unchanged');
          }
        }
        return patchedBodies.get(this);
      },
    });
  }

  // --- fetch hook (Flow may use fetch instead of XHR) ---
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;

    const shouldPatch = matchesTarget(url, spec) || (!spec && matchesTarget(url, null));
    const response = await originalFetch(input, init);
    if (!shouldPatch) return response;

    if (!spec) {
      diagnostic.heldForSpec = true;
      if (!allowPassthrough) {
        return new Response('', {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      return response;
    }

    try {
      const text = await response.clone().text();
      const result = patchResponse(text, spec);
      diagnostic.applied++;
      setState('applied', result.before);
      return new Response(result.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      setState('schema mismatch — unchanged');
      return response;
    }
  };

  let tries = 0;
  const armWith = (next, state = 'armed') => {
    if (spec) return;
    spec = next;
    allowPassthrough = true;
    setState(state);
  };

  const requestSpec = () => {
    if (spec || allowPassthrough) return;
    if (tries >= 40) {
      armWith(FALLBACK_SPEC, 'armed');
      return;
    }
    tries++;
    window.postMessage({ type: SPEC_REQ }, location.origin);
    setTimeout(requestSpec, 500);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.type !== SPEC_MSG) return;
    if (spec) return;

    if (!isValidSpec(data.spec)) {
      armWith(FALLBACK_SPEC, 'armed');
      return;
    }

    armWith(data.spec);
  });

  installHistoryGuards();
  requestSpec();
  setState('awaiting-spec');
})();
