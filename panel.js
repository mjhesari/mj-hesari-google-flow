const SITES = {
    flow: {
      id: 'flow',
      origin: 'https://flow.google.com',
      reloadLabel: 'بارگذاری دوباره گوگل فلو',
      clearLabel: 'بازنشانی کامل Flow',
    },
    stitch: {
      id: 'stitch',
      origin: 'https://stitch.withgoogle.com',
      reloadLabel: 'بارگذاری دوباره گوگل استیچ',
      clearLabel: 'بازنشانی کامل Stitch',
    },
  },
  SCRIPT_IDS = ['flow-helper', 'stitch-helper'],
  BLOCKED_PATHS = ['/unsupported-country', '/unavailable'],
  STATES = {
    enabled: {
      dot: 'ok',
      strong: true,
      text: 'ابزار روشن است. برای اعمال تغییرات تب را رفرش کنید.',
    },
    disabled: {
      dot: 'idle',
      strong: false,
      text: 'ابزار خاموش است. ممکن است خطای تحریم نمایش داده شود.',
    },
    active: {
      dot: 'ok',
      strong: true,
      text: 'ابزار روی این تب فعال است و محدودیت دور زده شد.',
    },
    armed: {
      dot: 'armed',
      strong: false,
      text: 'در حال آماده‌سازی ابزار...',
    },
    awaitingSpec: {
      dot: 'armed',
      strong: false,
      text: 'در حال اتصال...',
    },
    specUnavailable: {
      dot: 'warn',
      strong: true,
      text: 'خطا در ارتباط. لطفا اینترنت خود را بررسی کنید.',
    },
    schemaMismatch: {
      dot: 'bad',
      strong: true,
      text: 'نیاز به آپدیت افزونه می‌باشد.',
    },
    reloadTab: {
      dot: 'warn',
      strong: false,
      text: 'برای فعال‌سازی، این صفحه را رفرش کنید.',
    },
    saved: {
      dot: 'ok',
      strong: true,
      text: 'تغییرات ذخیره شد. تب را رفرش کنید.',
    },
    cookiesCleared: {
      dot: 'ok',
      strong: true,
      text: 'داده‌های سایت پاک شد. صفحه تمیز بارگذاری می‌شود.',
    },
  },
  MSG_PICK_TAB = 'ابتدا وارد یک تب Flow یا Stitch شوید.',
  MSG_SAVE_FAILED = 'تنظیمات ذخیره نشد.',
  MSG_CLEAR_FAILED = 'بازنشانی داده‌ها انجام نشد.';

const toggle = document.getElementById('toggle'),
  statusEl = document.getElementById('status'),
  error = document.getElementById('error'),
  reload = document.getElementById('reload'),
  clearCookies = document.getElementById('clearCookies');

let tab;

function siteFromUrl(url) {
  if (url?.startsWith(SITES.stitch.origin)) return SITES.stitch;
  if (url?.startsWith(SITES.flow.origin)) return SITES.flow;
  return null;
}

function setStatus(key) {
  const state = STATES[key];
  statusEl.classList.toggle('is-strong', state.strong);
  statusEl.querySelector('.status-dot').className =
    'status-dot status-dot--' + state.dot;
  statusEl.querySelector('.status-text').textContent = state.text;
}

function setEnabled(enabled) {
  toggle.setAttribute('aria-checked', String(enabled));
}

async function init() {
  const scripts = await chrome.scripting.getRegisteredContentScripts({
    ids: SCRIPT_IDS,
  });
  const enabled = scripts.length > 0;
  setEnabled(enabled);
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = siteFromUrl(tab?.url);
  reload.hidden = !site;
  if (site) reload.textContent = site.reloadLabel;
  clearCookies.textContent = (site || SITES.flow).clearLabel;
  setStatus(enabled ? 'enabled' : 'disabled');

  if (site && enabled) {
    try {
      const status = await chrome.tabs.sendMessage(tab.id, { type: 'status' });
      if (status.applied) setStatus('active');
      else if (status.state === 'armed') setStatus('armed');
      else if (status.state === 'awaiting-spec') setStatus('awaitingSpec');
      else if (status.state === 'access-denied') setStatus('reloadTab');
      else if (
        status.state?.startsWith('spec unavailable') ||
        status.state?.startsWith('spec invalid')
      ) {
        setStatus('specUnavailable');
      } else if (status.state?.startsWith('schema mismatch')) {
        setStatus('schemaMismatch');
      } else {
        setStatus('reloadTab');
      }
    } catch {
      setStatus('reloadTab');
    }
  }

  toggle.disabled = false;
}

toggle.addEventListener('click', async () => {
  const next = toggle.getAttribute('aria-checked') !== 'true';
  toggle.disabled = true;
  error.textContent = '';
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'setEnabled',
      enabled: next,
    });
    if (!result?.ok) throw new Error(result?.error || MSG_SAVE_FAILED);
    setEnabled(next);
    setStatus('saved');
  } catch (err) {
    setEnabled(!next);
    error.textContent = err.message;
  } finally {
    toggle.disabled = false;
  }
});

document.getElementById('open').onclick = () =>
  chrome.tabs.create({ url: SITES.flow.origin + '/' });

document.getElementById('openStitch').onclick = () =>
  chrome.tabs.create({ url: SITES.stitch.origin + '/' });

reload.onclick = async () => {
  try {
    const current = await chrome.tabs.get(tab.id);
    const site = siteFromUrl(current.url);
    if (!site) throw new Error(MSG_PICK_TAB);
    const url = new URL(current.url);
    const blocked = BLOCKED_PATHS.find(
      (path) => url.pathname === path || url.pathname.endsWith(path),
    );
    if (blocked || url.searchParams.has('pli')) {
      url.pathname = blocked
        ? url.pathname.replace(new RegExp(blocked.replace('/', '\\/') + '\\/?$'), '/') ||
          '/'
        : url.pathname;
      url.searchParams.delete('pli');
      await chrome.tabs.update(tab.id, { url: url.href });
    } else {
      await chrome.tabs.reload(tab.id);
    }
    window.close();
  } catch (err) {
    error.textContent = err.message;
  }
};

clearCookies.onclick = async () => {
  clearCookies.disabled = true;
  error.textContent = '';
  try {
    const site = siteFromUrl(tab?.url) || SITES.flow;
    const result = await chrome.runtime.sendMessage({
      type: 'clearFlowSiteData',
      site: site.id,
      tabId: tab?.url?.startsWith(site.origin) ? tab.id : undefined,
    });
    if (result == null) {
      throw new Error(
        'پاسخی از افزونه نیامد. در chrome://extensions روی Reload بزنید.',
      );
    }
    if (!result.ok) {
      throw new Error(result.error || MSG_CLEAR_FAILED);
    }
    setStatus('cookiesCleared');
    if (!tab?.url?.startsWith(site.origin)) {
      await chrome.tabs.create({ url: site.origin + '/' });
    }
    window.close();
  } catch (err) {
    error.textContent = err?.message || String(err) || MSG_CLEAR_FAILED;
  } finally {
    clearCookies.disabled = false;
  }
};

init().catch((err) => {
  error.textContent = err.message;
});
