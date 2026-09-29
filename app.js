const SPEC_URL = 'https://flow.cfcnode.com/v1/flow-spec',
  SPEC_TTL_MS = 6 * 60 * 60 * 1000,
  FLOW_ORIGIN = 'https://flow.google.com',
  FLOW_COOKIE_DOMAINS = ['flow.google.com', '.flow.google.com'],
  registration = {
    id: 'flow-helper',
    matches: ['https://flow.google.com/*'],
    js: ['engine.js'],
    runAt: 'document_start',
    world: 'MAIN',
    persistAcrossSessions: true,
  },
  REGISTRATIONS = [registration],
  REGISTRATION_IDS = REGISTRATIONS.map((a) => a.id);

let specCache = null,
  specFetchedAt = 0,
  specInFlight = null,
  lastAutoResetAt = 0;

const AUTO_RESET_COOLDOWN_MS = 90_000;

function errText(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

async function clearFlowCookies() {
  const seen = new Set();
  const cookies = [];
  for (const domain of FLOW_COOKIE_DOMAINS) {
    let batch = [];
    try {
      batch = await chrome.cookies.getAll({ domain });
    } catch {
      continue;
    }
    for (const cookie of batch) {
      const key = [
        cookie.storeId,
        cookie.name,
        cookie.domain,
        cookie.path,
        cookie.partitionKey?.topLevelSite || '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      cookies.push(cookie);
    }
  }

  // Also catch host-only cookies visible for the origin URL.
  try {
    const byUrl = await chrome.cookies.getAll({ url: FLOW_ORIGIN + '/' });
    for (const cookie of byUrl) {
      if (!/(^|\.)flow\.google\.com$/i.test(cookie.domain.replace(/^\./, ''))) {
        continue;
      }
      const key = [
        cookie.storeId,
        cookie.name,
        cookie.domain,
        cookie.path,
        cookie.partitionKey?.topLevelSite || '',
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      cookies.push(cookie);
    }
  } catch {
    /* ignore */
  }

  let removed = 0;
  await Promise.all(
    cookies.map(async (cookie) => {
      try {
        const host = cookie.domain.replace(/^\./, '');
        const url = `http${cookie.secure ? 's' : ''}://${host}${cookie.path}`;
        const details = {
          url,
          name: cookie.name,
          storeId: cookie.storeId,
        };
        if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
        const out = await chrome.cookies.remove(details);
        if (out) removed++;
      } catch {
        /* skip one bad cookie */
      }
    }),
  );
  return removed;
}

async function clearOriginStorage() {
  // cookies must NOT be included: Chrome rejects origins + cookies together.
  if (!chrome.browsingData?.remove) {
    throw new Error('مجوز browsingData فعال نیست؛ افزونه را Reload کنید');
  }
  await chrome.browsingData.remove(
    { origins: [FLOW_ORIGIN] },
    {
      cacheStorage: true,
      indexedDB: true,
      localStorage: true,
      serviceWorkers: true,
    },
  );
}

async function clearTabStorage(tabId) {
  if (typeof tabId !== 'number' || !chrome.scripting?.executeScript) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        try {
          localStorage.clear();
        } catch {
          /* ignore */
        }
        try {
          sessionStorage.clear();
        } catch {
          /* ignore */
        }
        try {
          if (indexedDB.databases) {
            indexedDB.databases().then((dbs) => {
              for (const db of dbs) {
                if (db?.name) indexedDB.deleteDatabase(db.name);
              }
            });
          }
        } catch {
          /* ignore */
        }
      },
    });
  } catch {
    /* tab may not allow scripting */
  }
}

async function clearFlowSiteData(tabId) {
  const warnings = [];

  try {
    await clearOriginStorage();
  } catch (err) {
    warnings.push(errText(err));
  }

  let removedCookies = 0;
  try {
    removedCookies = await clearFlowCookies();
  } catch (err) {
    warnings.push(errText(err));
  }

  await clearTabStorage(tabId);

  if (removedCookies === 0 && warnings.length) {
    throw new Error(warnings.join(' | '));
  }

  return { removedCookies, warnings };
}

async function reloadFlowClean(tabId) {
  const cleanUrl = FLOW_ORIGIN + '/';
  if (typeof tabId === 'number') {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url?.startsWith(FLOW_ORIGIN)) {
        await chrome.tabs.update(tabId, { url: cleanUrl });
        return;
      }
    } catch {
      /* tab may be gone */
    }
  }
  try {
    const tabs = await chrome.tabs.query({ url: FLOW_ORIGIN + '/*' });
    if (tabs[0]?.id != null) {
      await chrome.tabs.update(tabs[0].id, { url: cleanUrl });
    }
  } catch {
    /* ignore */
  }
}

async function fetchSpec() {
  const now = Date.now();
  if (specCache && now - specFetchedAt < SPEC_TTL_MS) return specCache;
  if (specInFlight) return specInFlight;
  specInFlight = (async () => {
    try {
      const res = await fetch(SPEC_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('spec HTTP ' + res.status);
      const json = await res.json();
      specCache = json;
      specFetchedAt = Date.now();
      return json;
    } catch (err) {
      console.warn('MJ Hesari Flow spec fetch failed:', errText(err));
      return specCache;
    } finally {
      specInFlight = null;
    }
  })();
  return specInFlight;
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  try {
    await chrome.scripting.registerContentScripts(REGISTRATIONS);
  } catch (err) {
    console.error('MJ Hesari Flow setup failed:', errText(err));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id && sender.id !== chrome.runtime.id) return;

  if (message?.type === 'getSpec') {
    fetchSpec()
      .then((spec) => sendResponse({ ok: !!spec, spec }))
      .catch((err) => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  if (!sender.tab && message?.type === 'setEnabled') {
    (async () => {
      const existing = await chrome.scripting.getRegisteredContentScripts({
        ids: REGISTRATION_IDS,
      });
      if (message.enabled && existing.length === 0) {
        await chrome.scripting.registerContentScripts(REGISTRATIONS);
      }
      if (!message.enabled && existing.length > 0) {
        await chrome.scripting.unregisterContentScripts({
          ids: REGISTRATION_IDS,
        });
      }
      sendResponse({ ok: true });
    })().catch((err) => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  if (
    message?.type === 'clearFlowSiteData' ||
    message?.type === 'clearFlowCookies'
  ) {
    (async () => {
      if (message.auto) {
        if (Date.now() - lastAutoResetAt < AUTO_RESET_COOLDOWN_MS) {
          sendResponse({ ok: true, skipped: true, reason: 'cooldown' });
          return;
        }
        lastAutoResetAt = Date.now();
      }
      const tabId = message.tabId ?? sender.tab?.id;
      const result = await clearFlowSiteData(tabId);
      await reloadFlowClean(tabId);
      sendResponse({ ok: true, ...result });
    })().catch((err) => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  return false;
});
