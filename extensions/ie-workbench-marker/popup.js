/**
 * popup：检测当前标签页是否已注入，并提供显示/隐藏浮层与注入兜底。
 * 不申请 tabs 权限：只用标签页 id，不读取 URL/标题。
 */

const statusEl = document.getElementById('status');
const toggleBtn = document.getElementById('toggle');
const injectBtn = document.getElementById('inject');

let tabId = null;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function refresh() {
  tabId = await getActiveTabId();
  if (!tabId) {
    setStatus('无法获取当前标签页', 'bad');
    toggleBtn.disabled = true;
    injectBtn.hidden = false;
    return;
  }

  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'status' });
    if (!res?.ok) throw new Error('no response');

    if (!res.stationId) {
      setStatus('已连接，但当前不是工作台页面（#/workbench/…）', 'warn');
      toggleBtn.disabled = true;
    } else {
      const video = res.hasVideo ? `视频 ${Number(res.time ?? 0).toFixed(2)}s` : '未检测到视频';
      setStatus(`工位 ${res.stationId} · 标记 ${res.marks} 个 · ${video}`, res.hasVideo ? 'ok' : 'warn');
      toggleBtn.disabled = false;
    }
    injectBtn.hidden = true;
  } catch {
    setStatus('当前页面未注入打点辅助', 'bad');
    toggleBtn.disabled = true;
    injectBtn.hidden = false;
  }
}

toggleBtn.addEventListener('click', async () => {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'toggle' });
    await refresh();
  } catch {
    setStatus('操作失败：页面可能已刷新，请重新打开 popup', 'bad');
  }
});

injectBtn.addEventListener('click', async () => {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await chrome.tabs.sendMessage(tabId, { type: 'toggle' });
    await refresh();
  } catch {
    setStatus('注入失败：请到「站点与设置」授权该站点，然后刷新页面', 'bad');
  }
});

document.getElementById('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

void refresh();