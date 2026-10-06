const SPEC_URL = 'https://flow.cfcnode.com/v1/flow-spec',
  SPEC_TTL_MS = 6 * 60 * 60 * 1000,
  SITES = {
    flow: {
      id: 'flow',
      origin: 'https://flow.google.com',
      hosts: ['flow.google.com'],
    },
    stitch: {
      id: 'stitch',
      origin: 'https://stitch.withgoogle.com',
      hosts: ['stitch.withgoogle.com'],
    },
  },
  registration = {
    id: 'flow-helper',
    matches: ['https://flow.google.com/*'],
    js: ['engine.js'],
    runAt: 'document_start',
    world: 'MAIN',
    persistAcrossSessions: true,
  },
  stitchRegistration = {
    id: 'stitch-helper',
    matches: ['https://stitch.withgoogle.com/*'],
    js: ['engine.js'],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: true,
    persistAcrossSessions: true,
  },
  REGISTRATIONS = [registration, stitchRegistration],
  REGISTRATION_IDS = REGISTRATIONS.map((item) => item.id);

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

function siteFromUrl(url) {
  if (typeof url !== 'string') return null;
  if (url.startsWith(SITES.stitch.origin)) return SITES.stitch;
  if (url.startsWith(SITES.flow.origin)) return SITES.flow;
  return null;
}

function domainMatches(domain, host) {
  const bare = String(domain || '').replace(/^\./, '').toLowerCase();
  const needle = host.toLowerCase();
  return bare === needle || bare.endsWith('.' + needle);
}

function resolveSite(message, sender) {
  if (message?.site && SITES[message.site]) return SITES[message.site];
  return siteFromUrl(sender.tab?.url) || SITES.flow;
}

async function clearSiteCookies(site) {
  const seen = new Set();
  const cookies = [];
  const domains = site.hosts.flatMap((host) => [host, '.' + host]);
  for (const domain of domains) {
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
    const byUrl = await chrome.cookies.getAll({ url: site.origin + '/' });
    for (const cookie of byUrl) {
      if (!site.hosts.some((host) => domainMatches(cookie.domain, host))) {
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

async function clearOriginStorage(site) {
  // cookies must NOT be included: Chrome rejects origins + cookies together.
  if (!chrome.browsingData?.remove) {
    throw new Error('مجوز browsingData فعال نیست؛ افزونه را Reload کنید');
  }
  await chrome.browsingData.remove(
    { origins: [site.origin] },
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

async function clearSiteData(site, tabId) {
  const warnings = [];

  try {
    await clearOriginStorage(site);
  } catch (err) {
    warnings.push(errText(err));
  }

  let removedCookies = 0;
  try {
    removedCookies = await clearSiteCookies(site);
  } catch (err) {
    warnings.push(errText(err));
  }

  await clearTabStorage(tabId);

  if (removedCookies === 0 && warnings.length) {
    throw new Error(warnings.join(' | '));
  }

  return { removedCookies, warnings };
}

async function reloadClean(site, tabId) {
  const cleanUrl = site.origin + '/';
  if (typeof tabId === 'number') {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url?.startsWith(site.origin)) {
        await chrome.tabs.update(tabId, { url: cleanUrl });
        return;
      }
    } catch {
      /* tab may be gone */
    }
  }
  try {
    const tabs = await chrome.tabs.query({ url: site.origin + '/*' });
    if (tabs[0]?.id != null) {
      await chrome.tabs.update(tabs[0].id, { url: cleanUrl });
    }
  } catch {
    /* ignore */
  }
}

async function syncRegistrations(enabled) {
  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: REGISTRATION_IDS,
  });
  if (!enabled) {
    if (!existing.length) return;
    await chrome.scripting.unregisterContentScripts({
      ids: existing.map((item) => item.id),
    });
    return;
  }
  const have = new Set(existing.map((item) => item.id));
  const missing = REGISTRATIONS.filter((item) => !have.has(item.id));
  if (missing.length) {
    try {
      await chrome.scripting.registerContentScripts(missing);
    } catch (err) {
      if (!/duplicate/i.test(errText(err))) throw err;
    }
  }
}

async function ensureCompanionSites() {
  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: REGISTRATION_IDS,
  });
  const have = new Set(existing.map((item) => item.id));
  if (!have.has(registration.id) && !have.has(stitchRegistration.id)) return;
  const missing = REGISTRATIONS.filter((item) => !have.has(item.id));
  if (!missing.length) return;
  try {
    await chrome.scripting.registerContentScripts(missing);
  } catch (err) {
    if (!/duplicate/i.test(errText(err))) throw err;
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
    await syncRegistrations(true);
  } catch (err) {
    console.error('MJ Hesari Flow setup failed:', errText(err));
  }
});

ensureCompanionSites().catch((err) => {
  console.error('MJ Hesari Flow setup failed:', errText(err));
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id && sender.id !== chrome.runtime.id) return;

  if (message?.type === 'getSpec') {
    if (siteFromUrl(sender.tab?.url)?.id === 'stitch') {
      sendResponse({
        ok: true,
        spec: {
          origin: SITES.stitch.origin,
          path: '/_/Nemo/data/batchexecute',
          rpcids: 'N5xENe',
          tag: 'wrb.fr',
          flagIndex: 0,
          minLength: 1,
          lenient: true,
          namedGates: true,
        },
      });
      return false;
    }
    fetchSpec()
      .then((spec) => sendResponse({ ok: !!spec, spec }))
      .catch((err) => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  if (!sender.tab && message?.type === 'setEnabled') {
    (async () => {
      await syncRegistrations(!!message.enabled);
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
      const site = resolveSite(message, sender);
      const tabId = message.tabId ?? sender.tab?.id;
      const result = await clearSiteData(site, tabId);
      await reloadClean(site, tabId);
      sendResponse({ ok: true, site: site.id, ...result });
    })().catch((err) => sendResponse({ ok: false, error: errText(err) }));
    return true;
  }

  return false;
});
