(() => {
  'use strict';

  const SPEC_MSG = 'cfc-flow-spec';
  const SPEC_REQ = 'cfc-flow-spec-request';
  const ACCESS_DENIED_MSG = 'cfc-flow-access-denied';
  const BLOCKED_PATHS = ['/unavailable', '/unsupported-country'];
  const STRIP_PARAMS = ['pli'];
  const ACCESS_DENIED_RE = /don'?t have access to Flow/i;
  const STITCH_ACCESS_DENIED_RE =
    /don'?t have access to Stitch|Stitch is not available|not available in your country|not enabled for Stitch|isStitchEnabledInCountry\s*[:=]\s*false/i;
  const BATCH_PATH = '/_/AiSandboxAngularFrontend/data/batchexecute';
  const STITCH_BATCH_PATH = '/_/Nemo/data/batchexecute';
  const IS_STITCH =
    typeof location !== 'undefined' &&
    location.hostname === 'stitch.withgoogle.com';

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

  const nativeJSONParse = JSON.parse;
  const GATE_KEYS = new Set([
    'isStitchEnabledInCountry',
    'isEnabledInCountry',
    'stitchEnabledInCountry',
    'isAvailableInCountry',
    'STITCH_ENABLED_IN_COUNTRY',
  ]);

  function isGateKey(key) {
    return GATE_KEYS.has(key);
  }

  function flipNamedGates(node, seen) {
    if (!node || typeof node !== 'object') return 0;
    const visited = seen || new Set();
    if (visited.has(node)) return 0;
    visited.add(node);
    let count = 0;

    if (Array.isArray(node)) {
      if (
        node.length >= 2 &&
        typeof node[0] === 'string' &&
        isGateKey(node[0]) &&
        node[1] === false
      ) {
        node[1] = true;
        count++;
      }
      for (let i = 0; i < node.length; i++) {
        const item = node[i];
        if (typeof item === 'string' && item.includes('isStitchEnabledInCountry')) {
          try {
            const inner = nativeJSONParse(item);
            const innerHits = flipNamedGates(inner, visited);
            if (innerHits) {
              node[i] = JSON.stringify(inner);
              count += innerHits;
              continue;
            }
          } catch {
            /* prose, not JSON */
          }
        }
        count += flipNamedGates(item, visited);
      }
      return count;
    }

    for (const key of Object.keys(node)) {
      const value = node[key];
      if (isGateKey(key) && value === false) {
        node[key] = true;
        count++;
        continue;
      }
      if (typeof value === 'string' && value.includes('isStitchEnabledInCountry')) {
        try {
          const inner = nativeJSONParse(value);
          const innerHits = flipNamedGates(inner, visited);
          if (innerHits) {
            node[key] = JSON.stringify(inner);
            count += innerHits;
            continue;
          }
        } catch {
          /* prose, not JSON */
        }
      }
      count += flipNamedGates(value, visited);
    }
    return count;
  }

  function rewriteGateLiterals(text) {
    const keys =
      'isStitchEnabledInCountry|isEnabledInCountry|stitchEnabledInCountry|isAvailableInCountry|STITCH_ENABLED_IN_COUNTRY';
    const plain = new RegExp('"' + '(' + keys + ')' + '"\\s*:\\s*false', 'g');
    const escaped = new RegExp(
      '\\\\"' + '(' + keys + ')' + '\\\\"\\s*:\\s*false',
      'g',
    );
    return text
      .replace(plain, '"$1":true')
      .replace(escaped, '\\"$1\\":true');
  }

  const STITCH_GATE_MARKER = 'User is not enabled for Stitch';

  function matchingParen(code, openAt) {
    let depth = 0;
    let quote = '';
    for (let i = openAt; i < code.length; i++) {
      const ch = code[i];
      if (quote) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function endOfThrowStatement(code, throwAt) {
    let quote = '';
    let paren = 0;
    for (let i = throwAt + 5; i < code.length; i++) {
      const ch = code[i];
      if (quote) {
        if (ch === '\\') {
          i++;
          continue;
        }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if ((ch === ';' || ch === '\n') && paren === 0) return i + (ch === ';' ? 1 : 0);
    }
    return code.length;
  }

  /**
   * The country check is compiled into m=oxe1Cc as a throw, not a JSON key:
   *   if (!enabled) throw Error("User is not enabled for Stitch (... isStitchEnabledInCountry=" + flag + ")")
   * Force that if to false so loadUserSettings continues.
   */
  function neutralizeStitchGate(code) {
    if (typeof code !== 'string' || !code.includes(STITCH_GATE_MARKER)) return code;
    let out = '';
    let cursor = 0;
    while (cursor < code.length) {
      const at = code.indexOf(STITCH_GATE_MARKER, cursor);
      if (at < 0) {
        out += code.slice(cursor);
        break;
      }

      const windowStart = Math.max(0, at - 500);
      const before = code.slice(windowStart, at);
      const ifRel = before.lastIndexOf('if');
      if (ifRel >= 0) {
        const ifAt = windowStart + ifRel;
        const prev = ifAt > 0 ? code[ifAt - 1] : '';
        const paren = code.indexOf('(', ifAt);
        if ((!prev || !/[\w$]/.test(prev)) && paren > ifAt && paren < at) {
          const close = matchingParen(code, paren);
          const gap = close > paren ? code.slice(close + 1, at) : null;
          if (gap != null && gap.length < 400 && !gap.includes(';')) {
            out +=
              code.slice(cursor, paren + 1) +
              'false' +
              code.slice(close, at + STITCH_GATE_MARKER.length);
            cursor = at + STITCH_GATE_MARKER.length;
            continue;
          }
        }
      }

      const throwRel = before.lastIndexOf('throw');
      if (throwRel >= 0) {
        const throwAt = windowStart + throwRel;
        const prev = throwAt > 0 ? code[throwAt - 1] : '';
        const end = endOfThrowStatement(code, throwAt);
        if ((!prev || !/[\w$]/.test(prev)) && at >= throwAt && at < end) {
          out += code.slice(cursor, throwAt) + 'return arguments[0]';
          cursor = end;
          continue;
        }
      }

      out += code.slice(cursor, at + STITCH_GATE_MARKER.length);
      cursor = at + STITCH_GATE_MARKER.length;
    }
    return out;
  }

  function patchStitchModule(code) {
    if (typeof code !== 'string') return code;
    let next = code;
    if (next.includes('mL6Y7b')) {
      next = next.replace(
        /this\.M=_\.np\(_\.je\("mL6Y7b"\),!1\)/g,
        'this.M=!0',
      );
    }
    return neutralizeStitchGate(next);
  }

  function isStitchGateScript(url) {
    return (
      typeof url === 'string' &&
      url.includes('gstatic.com') &&
      url.includes('oxe1Cc')
    );
  }

  let stitchScriptPolicy;
  let stitchScriptPolicyReady = false;

  function stitchScriptPolicyOf() {
    if (stitchScriptPolicyReady) return stitchScriptPolicy;
    stitchScriptPolicyReady = true;
    const tt = window.trustedTypes;
    if (!tt) return (stitchScriptPolicy = null);
    const rules = { createScript: (input) => String(input) };
    for (const name of ['mj-hesari#stitch']) {
      try {
        stitchScriptPolicy = tt.createPolicy(name, rules);
        return stitchScriptPolicy;
      } catch {
        /* this policy name is not allowed by the page */
      }
    }
    stitchScriptPolicy = null;
    return null;
  }

  function asTrustedScript(code) {
    const tt = window.trustedTypes;
    if (!tt || typeof code !== 'string') return code;
    if (typeof tt.isScript === 'function' && tt.isScript(code)) return code;
    const policy = stitchScriptPolicyOf();
    if (!policy?.createScript) return code;
    return policy.createScript(code);
  }

  function installStitchSourceHooks() {
    const rewrite = (value) =>
      typeof value === 'string' ? patchStitchModule(value) : value;

    const nativeEval = window.eval;
    window.eval = function (value) {
      return nativeEval.call(window, rewrite(value));
    };

    const textDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'text');
    if (textDesc?.set && textDesc.configurable) {
      Object.defineProperty(HTMLScriptElement.prototype, 'text', {
        configurable: true,
        enumerable: textDesc.enumerable,
        get: textDesc.get,
        set(value) {
          if (typeof value !== 'string') return textDesc.set.call(this, value);
          const next = patchStitchModule(value);
          try {
            return textDesc.set.call(this, asTrustedScript(next));
          } catch (err) {
            if (next === value) throw err;
            return textDesc.set.call(this, value);
          }
        },
      });
    }

    const innerDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    if (innerDesc?.set && innerDesc.configurable) {
      Object.defineProperty(Element.prototype, 'innerHTML', {
        configurable: true,
        enumerable: innerDesc.enumerable,
        get: innerDesc.get,
        set(value) {
          return innerDesc.set.call(
            this,
            typeof value === 'string' &&
            (value.includes(STITCH_GATE_MARKER) || value.includes('mL6Y7b'))
              ? patchStitchModule(value)
              : value,
          );
        },
      });
    }

    const patchNode = (node) => {
      if (!node) return node;
      if (node.tagName === 'SCRIPT') {
        const text = node.text;
        if (text && (text.includes(STITCH_GATE_MARKER) || text.includes('mL6Y7b'))) {
          node.text = text;
        }
      } else if (
        node.nodeType === 3 &&
        node.data &&
        (node.data.includes(STITCH_GATE_MARKER) || node.data.includes('mL6Y7b'))
      ) {
        node.data = patchStitchModule(node.data);
      }
      return node;
    };

    const gateScripts = new WeakMap();
    const bypassSrc = new WeakSet();
    const scriptNonces = new WeakMap();
    const srcDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    const nonceDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'nonce');

    function rememberNonce(script, value) {
      if (value) scriptNonces.set(script, String(value));
    }

    function armGateScript(script, url) {
      if (gateScripts.has(script) || bypassSrc.has(script)) return;
      rememberNonce(script, script.nonce || script.getAttribute('nonce'));
      const promise = fetch(url, { credentials: 'omit', cache: 'force-cache' })
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          return res.text();
        })
        .then((code) => patchStitchModule(code))
        .catch(() => null);
      gateScripts.set(script, {
        url,
        promise,
        settled: false,
        code: null,
        applied: false,
      });
      promise.then((code) => {
        const record = gateScripts.get(script);
        if (!record || record.applied) return;
        record.settled = true;
        record.code = code;
        if (record.inserted || script.isConnected) applyGateScript(script);
      });
    }

    function assignPatchedText(script, code) {
      const trusted = asTrustedScript(code);
      if (!window.trustedTypes) {
        script.text = code;
        return Promise.resolve(script);
      }
      if (typeof trusted !== 'string') {
        try {
          textDesc.set.call(script, trusted);
          return Promise.resolve(script);
        } catch {
          /* policy output was rejected; isolated world will assign the text */
        }
      }
      const id = Math.random().toString(36).slice(2);
      const holder = document.createElement('template');
      holder.id = 'mj-gate-' + id;
      holder.content.appendChild(script);
      document.documentElement.appendChild(holder);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          const moved = holder.content.querySelector('script') || script;
          if (holder.parentNode) holder.remove();
          resolve(ok ? moved : null);
        };
        const onMsg = (event) => {
          if (event.source !== window) return;
          if (event.data?.type !== 'cfc-stitch-applied' || event.data.id !== id) return;
          finish(!!event.data.ok);
        };
        window.addEventListener('message', onMsg);
        const timer = setTimeout(() => finish(false), 2000);
        window.postMessage({ type: 'cfc-stitch-apply', id, code }, location.origin);
      });
    }

    function placeScript(script, record, parent, next) {
      if (script.isConnected) return;
      if (record.insert) record.insert();
      else if (parent) parent.insertBefore(script, next);
    }

    function restoreOriginalSrc(script, record, parent, next) {
      bypassSrc.add(script);
      if (srcDesc?.set) srcDesc.set.call(script, record.url);
      placeScript(script, record, parent, next);
    }

    function applyGateScript(script) {
      const record = gateScripts.get(script);
      if (!record || record.applied) return;
      record.applied = true;
      const nonce = scriptNonces.get(script) || script.getAttribute('nonce');
      const parent = script.parentNode;
      const next = script.nextSibling;
      if (typeof record.code !== 'string') {
        restoreOriginalSrc(script, record, parent, next);
        return;
      }
      if (parent) script.remove();
      if (nonce) nativeSetAttribute.call(script, 'nonce', nonce);
      assignPatchedText(script, record.code)
        .then((patched) => {
          const node = patched || script;
          if (!patched) {
            restoreOriginalSrc(node, record, parent, next);
            return;
          }
          placeScript(node, record, parent, next);
          node.dispatchEvent(new Event('load'));
        })
        .catch(() => {
          restoreOriginalSrc(script, record, parent, next);
        });
    }

    if (srcDesc?.set && srcDesc.configurable) {
      Object.defineProperty(HTMLScriptElement.prototype, 'src', {
        configurable: true,
        enumerable: srcDesc.enumerable,
        get: srcDesc.get,
        set(value) {
          const url = String(value);
          if (!bypassSrc.has(this) && isStitchGateScript(url)) {
            armGateScript(this, url);
            return;
          }
          return srcDesc.set.call(this, value);
        },
      });
    }

    if (nonceDesc?.set && nonceDesc.configurable) {
      Object.defineProperty(HTMLElement.prototype, 'nonce', {
        configurable: true,
        enumerable: nonceDesc.enumerable,
        get: nonceDesc.get,
        set(value) {
          rememberNonce(this, value);
          return nonceDesc.set.call(this, value);
        },
      });
    }

    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      const key = String(name).toLowerCase();
      if (key === 'nonce') rememberNonce(this, value);
      if (this.tagName === 'SCRIPT' && key === 'src' && isStitchGateScript(String(value))) {
        this.src = value;
        return;
      }
      return nativeSetAttribute.call(this, name, value);
    };

    for (const method of ['appendChild', 'insertBefore', 'replaceChild']) {
      const original = Node.prototype[method];
      if (typeof original !== 'function') continue;
      Node.prototype[method] = function (...args) {
        const node = args[0];
        if (node && gateScripts.has(node)) {
          const record = gateScripts.get(node);
          if (record.applied) return original.apply(this, args);
          record.inserted = true;
          record.insert = () => original.apply(this, args);
          if (record.settled) applyGateScript(node);
          return node;
        }
        if (node) args[0] = patchNode(node);
        return original.apply(this, args);
      };
    }

    const NativeBlob = window.Blob;
    function PatchedBlob(parts, options) {
      const next = Array.isArray(parts)
        ? parts.map((part) =>
            typeof part === 'string' &&
            (part.includes(STITCH_GATE_MARKER) || part.includes('mL6Y7b'))
              ? patchStitchModule(part)
              : part,
          )
        : parts;
      if (!new.target) return new NativeBlob(next, options);
      return Reflect.construct(NativeBlob, [next, options], new.target);
    }
    PatchedBlob.prototype = NativeBlob.prototype;
    Object.setPrototypeOf(PatchedBlob, NativeBlob);
    window.Blob = PatchedBlob;

    const nativeWrite = document.write;
    document.write = function (...args) {
      return nativeWrite.apply(
        document,
        args.map((part) => rewrite(part)),
      );
    };
    if (typeof document.writeln === 'function') {
      const nativeWriteln = document.writeln;
      document.writeln = function (...args) {
        return nativeWriteln.apply(
          document,
          args.map((part) => rewrite(part)),
        );
      };
    }
  }

  /**
   * Stitch keeps the country gate on GET_APP_CONFIG (N5xENe) as
   * isStitchEnabledInCountry=false, then bounces to /?pli=1.
   * Flip that gate only — leave project payloads alone.
   */
  function patchStitchResponse(body) {
    const lines = body.split('\n');
    let hits = 0;
    const allFlipped = [];

    const commit = (index, oldLine, newLine, label) => {
      if (newLine === oldLine) return false;
      adjustFrameLength(lines, index, oldLine, newLine);
      lines[index] = newLine;
      hits++;
      allFlipped.push(label);
      return true;
    };

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('[[')) continue;
      const oldLine = lines[i];
      let chunks;
      try {
        chunks = nativeJSONParse(oldLine);
      } catch {
        try {
          commit(i, oldLine, rewriteGateLiterals(oldLine), 'literal');
        } catch {
          /* length prefix did not match; leave the frame */
        }
        continue;
      }
      if (!Array.isArray(chunks)) continue;

      let changed = false;
      for (const chunk of chunks) {
        if (!Array.isArray(chunk) || chunk[0] !== 'wrb.fr') continue;
        if (typeof chunk[2] !== 'string') continue;

        let payload;
        try {
          payload = nativeJSONParse(chunk[2]);
        } catch {
          const rewritten = rewriteGateLiterals(chunk[2]);
          if (rewritten === chunk[2]) continue;
          chunk[2] = rewritten;
          changed = true;
          allFlipped.push(`${chunk[1]}:literal`);
          continue;
        }

        if (typeof payload === 'string' && payload.includes('isStitchEnabledInCountry')) {
          try {
            const inner = nativeJSONParse(payload);
            const innerHits = flipNamedGates(inner);
            if (innerHits) {
              chunk[2] = JSON.stringify(JSON.stringify(inner));
              changed = true;
              allFlipped.push(`${chunk[1]}:gate`);
              continue;
            }
          } catch {
            /* not a JSON string */
          }
        }

        let named = flipNamedGates(payload);
        if (!named) continue;
        chunk[2] = JSON.stringify(payload);
        changed = true;
        allFlipped.push(`${chunk[1]}:gate`);
      }

      if (!changed) {
        try {
          commit(i, oldLine, rewriteGateLiterals(oldLine), 'literal');
        } catch {
          /* unchanged frame */
        }
        continue;
      }

      try {
        commit(i, oldLine, JSON.stringify(chunks), 'frame');
      } catch {
        /* length prefix did not match; leave the frame */
      }
    }

    return {
      body: lines.join('\n'),
      before: undefined,
      hits,
      flipped: allFlipped,
      unchanged: hits === 0,
    };
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = {
      patch: (body) => patchResponse(body, FALLBACK_SPEC),
      patchStitch: (body) => patchStitchResponse(body),
      neutralizeStitchGate,
      patchStitchModule,
    };
    return;
  }

  const DIAG_KEY = IS_STITCH ? '__stitchLocalDiagnostic' : '__flowLocalDiagnostic';
  if (window[DIAG_KEY]) return;

  if (IS_STITCH) {
    installStitchSourceHooks();
    JSON.parse = function (text, reviver) {
      const value = nativeJSONParse.call(this, text, reviver);
      if (typeof text === 'string' && text.includes('isStitchEnabledInCountry')) {
        try {
          flipNamedGates(value);
        } catch {
          /* leave the parsed value untouched */
        }
      }
      return value;
    };
  }

  const diagnostic = (window[DIAG_KEY] = {
    state: 'awaiting-spec',
    applied: 0,
    flipped: [],
    product: IS_STITCH ? 'stitch' : 'flow',
  });

  const DIAGNOSTIC_ATTR = IS_STITCH
    ? 'data-stitch-local-diagnostic'
    : 'data-flow-local-diagnostic';
  const LOG_TAG = IS_STITCH ? '[MJ Hesari Stitch]' : '[MJ Hesari Flow]';

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
    const clean = next.pathname + next.search + next.hash;
    if (!IS_STITCH) {
      history.replaceState(history.state, '', clean);
      return;
    }
    // One full navigation off /?pli=1 so the denial document does not stay
    // painted. A second hit of the same URL stops, instead of looping.
    const guard = 'mj-hesari-stitch-escape';
    const signature = location.pathname + location.search;
    try {
      if (sessionStorage.getItem(guard) === signature) {
        reportAccessDenied('pli-route');
        return;
      }
      sessionStorage.setItem(guard, signature);
    } catch {
      /* sessionStorage blocked */
    }
    location.replace(clean);
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

  function sameDocument(urlLike) {
    try {
      const url = new URL(urlLike, location.href);
      return (
        url.pathname === location.pathname &&
        url.search === location.search &&
        url.hash === location.hash
      );
    } catch {
      return false;
    }
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
            const rewritten = rewrite(String(value));
            if (sameDocument(rewritten)) return;
            return desc.set.call(this, rewritten);
          },
        });
      }
      for (const method of ['assign', 'replace']) {
        const original = proto[method];
        if (typeof original !== 'function') continue;
        proto[method] = function (url) {
          const rewritten = rewrite(String(url));
          if (sameDocument(rewritten)) return;
          return original.call(this, rewritten);
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
      const deniedRe = IS_STITCH ? STITCH_ACCESS_DENIED_RE : ACCESS_DENIED_RE;
      if (!deniedRe.test(text)) return;
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
          parsed.pathname === STITCH_BATCH_PATH ||
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
    const result = IS_STITCH ? patchStitchResponse(value) : patchResponse(value, spec);
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
    if (IS_STITCH) return;
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
  if (!IS_STITCH) requestSpec();
})();
