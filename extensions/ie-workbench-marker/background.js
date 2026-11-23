/**
 * Service worker：维护「额外授权站点」的 content script 动态注册。
 *
 * 默认站点（localhost / 127.0.0.1）由 manifest.content_scripts 静态注入；
 * 生产内网域名由选项页申请 optional host permission 后，在这里动态注册。
 *
 * 纪律：service worker 不保存任何状态，所有来源都读 chrome.storage。
 */

const EXTRA_KEY = 'extraOrigins';

/** Chrome 站点匹配模式不支持端口：统一为 scheme://host */
function normalizeOrigin(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return null;
  }
}

async function getExtraOrigins() {
  const stored = await chrome.storage.local.get(EXTRA_KEY);
  const list = Array.isArray(stored[EXTRA_KEY]) ? stored[EXTRA_KEY] : [];
  return [...new Set(list.map(normalizeOrigin).filter(Boolean))];
}

function scriptIdOf(origin) {
  return `site-${origin.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

async function registerOrigin(origin) {
  const id = scriptIdOf(origin);
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch {
    // 未注册过：忽略
  }
  await chrome.scripting.registerContentScripts([
    {
      id,
      matches: [`${origin}/*`],
      js: ['content.js'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    },
  ]);
}

async function unregisterOrigin(origin) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [scriptIdOf(origin)] });
  } catch {
    // 未注册：忽略
  }
}

async function restoreAll() {
  const origins = await getExtraOrigins();
  for (const origin of origins) {
    try {
      await registerOrigin(origin);
    } catch (err) {
      console.warn(`[ie-marker] 恢复站点注册失败 ${origin}:`, err);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void restoreAll();
});

chrome.runtime.onStartup.addListener(() => {
  void restoreAll();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === 'list-origins') {
        sendResponse({ ok: true, origins: await getExtraOrigins() });
        return;
      }

      if (message?.type === 'add-origin') {
        const origin = normalizeOrigin(message.origin);
        if (!origin) {
          sendResponse({ ok: false, error: '站点格式无效' });
          return;
        }
        const origins = await getExtraOrigins();
        if (!origins.includes(origin)) {
          origins.push(origin);
          await chrome.storage.local.set({ [EXTRA_KEY]: origins });
        }
        await registerOrigin(origin);
        sendResponse({ ok: true, origins });
        return;
      }

      if (message?.type === 'remove-origin') {
        const origin = normalizeOrigin(message.origin);
        if (!origin) {
          sendResponse({ ok: false, error: '站点格式无效' });
          return;
        }
        const origins = (await getExtraOrigins()).filter((o) => o !== origin);
        await chrome.storage.local.set({ [EXTRA_KEY]: origins });
        await unregisterOrigin(origin);
        sendResponse({ ok: true, origins });
        return;
      }

      sendResponse({ ok: false, error: 'unknown message' });
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
  })();
  return true;
});