/**
 * 选项页：管理额外授权站点。
 *
 * 关键约束：chrome.permissions.request 必须在用户手势的同一个同步回合内调用，
 * 因此在 submit 处理器里直接调用（前面不能有 await）。
 */

const DEFAULT_ORIGINS = ['http://localhost', 'http://127.0.0.1'];

const builtinEl = document.getElementById('builtin');
const extraEl = document.getElementById('extra');
const emptyEl = document.getElementById('empty');
const formEl = document.getElementById('add-form');
const inputEl = document.getElementById('origin');
const msgEl = document.getElementById('msg');

function setMsg(text, kind = '') {
  msgEl.textContent = text;
  msgEl.className = `msg${kind ? ` ${kind}` : ''}`;
}

function normalizeOrigin(value) {
  let raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Chrome 站点匹配模式不支持端口：按 host 授权，覆盖该主机的全部端口
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return null;
  }
}

function renderBuiltin() {
  builtinEl.textContent = '';
  for (const origin of DEFAULT_ORIGINS) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'origin';
    name.textContent = origin;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '内置';

    li.append(name, badge);
    builtinEl.appendChild(li);
  }
}

function renderExtra(origins) {
  extraEl.textContent = '';
  const list = Array.isArray(origins) ? origins : [];
  emptyEl.hidden = list.length > 0;

  for (const origin of list) {
    const li = document.createElement('li');

    const name = document.createElement('span');
    name.className = 'origin';
    name.textContent = origin;

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '移除';
    remove.addEventListener('click', () => {
      void removeOrigin(origin);
    });

    li.append(name, spacer, remove);
    extraEl.appendChild(li);
  }
}

async function loadOrigins() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'list-origins' });
    if (res?.ok) renderExtra(res.origins);
    else setMsg(`读取站点失败：${res?.error ?? '未知错误'}`, 'bad');
  } catch (err) {
    setMsg(`读取站点失败：${String(err?.message ?? err)}`, 'bad');
  }
}

async function completeAdd(origin) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'add-origin', origin });
    if (!res?.ok) {
      setMsg(`添加失败：${res?.error ?? '未知错误'}`, 'bad');
      return;
    }
    setMsg(`已添加 ${origin}，请刷新该页面后使用`, 'ok');
    inputEl.value = '';
    renderExtra(res.origins);
  } catch (err) {
    setMsg(`添加失败：${String(err?.message ?? err)}`, 'bad');
  }
}

async function removeOrigin(origin) {
  setMsg(`正在移除 ${origin}…`);
  try {
    await chrome.permissions.remove({ origins: [`${origin}/*`] });
  } catch {
    // 权限可能已不存在：继续移除注册与记录
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'remove-origin', origin });
    if (!res?.ok) {
      setMsg(`移除失败：${res?.error ?? '未知错误'}`, 'bad');
      return;
    }
    setMsg(`已移除 ${origin}`, 'ok');
    renderExtra(res.origins);
  } catch (err) {
    setMsg(`移除失败：${String(err?.message ?? err)}`, 'bad');
  }
}

formEl.addEventListener('submit', (event) => {
  event.preventDefault();
  const origin = normalizeOrigin(inputEl.value);
  if (!origin) {
    setMsg('请输入合法站点，例如 http://ie.example.local（不需要写端口）', 'bad');
    return;
  }
  if (DEFAULT_ORIGINS.includes(origin)) {
    setMsg('该站点已内置，无需重复添加', '');
    return;
  }

  // 用户手势内同步发起授权；回调里再做异步收尾
  chrome.permissions.request({ origins: [`${origin}/*`] }, (granted) => {
    if (!granted) {
      setMsg('未授权该站点，扩展无法访问该页面', 'bad');
      return;
    }
    void completeAdd(origin);
  });
});

renderBuiltin();
void loadOrigins();