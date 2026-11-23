/**
 * IE 工作台打点辅助 · content script
 *
 * 只在「分解工作台」路由（#/workbench/:stationId）显示浮层：
 *  - 读取页面主视频的当前时间，快捷键打点 / 标记循环；
 *  - 标记按工位持久化在 chrome.storage.local；
 *  - 导出 CSV（序号/手别/类型/描述/时长s），可直接用工作台的「导入 CSV」。
 *
 * 与页面零耦合：只读 <video>，不改工作台内部状态、不调用页面私有对象。
 * 浮层用 Shadow DOM 隔离，避免与页面样式互相污染。
 */

(() => {
  'use strict';

  // 同一 isolated world 内重复注入（静态 content script + 手工注入）时只执行一次
  if (window.__ieWorkbenchMarkerLoaded) return;
  window.__ieWorkbenchMarkerLoaded = true;

  const HOST_ID = 'ie-workbench-marker-hud';
  const MARKS_LIMIT = 500;
  const POS_KEY = 'hudPos';
  const COLLAPSED_KEY = 'hudCollapsed';

  let stationId = null;
  let marks = [];
  let video = null;
  let host = null;
  let root = null;
  let els = {};
  let tickTimer = null;
  let toastTimer = null;
  let collapsed = false;

  const marksKey = (sid) => `marks:${sid}`;
  const round2 = (n) => Math.round(n * 100) / 100;
  const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  function getStationId() {
    const m = location.hash.match(/^#\/workbench\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function findVideo() {
    const inScreen = document.querySelector('.wb-screen video');
    if (inScreen) return inScreen;
    const candidates = [...document.querySelectorAll('video')].filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width >= 200 && r.height >= 120;
    });
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    return candidates[0] ?? null;
  }

  async function loadMarks(sid) {
    const key = marksKey(sid);
    const stored = await chrome.storage.local.get(key);
    return Array.isArray(stored[key]) ? stored[key] : [];
  }

  async function saveMarks() {
    if (!stationId) return;
    await chrome.storage.local.set({ [marksKey(stationId)]: marks.slice(-MARKS_LIMIT) });
  }

  // ───────────────────────── 浮层 ─────────────────────────

  const TEMPLATE = `
    <style>
      :host { all: initial; }
      .hud {
        pointer-events: auto;
        position: fixed;
        right: 16px;
        bottom: 16px;
        width: 304px;
        z-index: 2147483647;
        background: #ffffff;
        color: #1f2937;
        border: 1px solid #d8dee6;
        border-radius: 10px;
        box-shadow: 0 12px 32px rgba(15, 23, 32, 0.18);
        font: 12px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
        overflow: hidden;
      }
      .hud.collapsed { width: auto; }
      .hud.collapsed .hud-body { display: none; }
      .hud-head {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 8px 10px;
        background: #f8fafc;
        border-bottom: 1px solid #e5e7eb;
        cursor: move;
        user-select: none;
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #b45309; flex: none; }
      .hud-head b { font-size: 12px; font-weight: 700; }
      .sid { color: #6b7280; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hud-head .spacer { flex: 1; }
      .hud-head button {
        border: 1px solid #d1d5db; background: #fff; color: #4b5563;
        border-radius: 5px; width: 22px; height: 22px; line-height: 1;
        cursor: pointer; font-size: 14px; padding: 0;
      }
      .hud-head button:hover { background: #eef2f7; }
      .hud-body { padding: 10px; }
      .time {
        display: flex; align-items: baseline; gap: 6px;
        margin-bottom: 8px; color: #6b7280;
      }
      .time .t { font-size: 20px; font-weight: 700; color: #111827; font-variant-numeric: tabular-nums; }
      .time .hint { margin-left: auto; font-size: 10px; color: #9ca3af; }
      .btns { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px; }
      button.act {
        border: 1px solid #d1d5db; background: #fff; color: #1f2937;
        border-radius: 6px; padding: 5px 6px; cursor: pointer; font: inherit;
        display: flex; align-items: center; justify-content: center; gap: 5px;
      }
      button.act:hover { background: #f3f6fa; border-color: #b8c2cf; }
      button.act.primary { background: #b45309; border-color: #b45309; color: #fff; font-weight: 600; }
      button.act.primary:hover { background: #92400e; border-color: #92400e; }
      kbd {
        font: 10px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
        background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 3px;
        padding: 1px 3px; color: #64748b;
      }
      button.act.primary kbd { background: rgba(255,255,255,.18); border-color: rgba(255,255,255,.28); color: #fff; }
      .form { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; margin-bottom: 8px; }
      .form label { display: flex; flex-direction: column; gap: 2px; color: #6b7280; font-size: 10px; }
      .form label.wide { grid-column: 1 / -1; }
      .form select, .form input {
        font: inherit; color: #111827; border: 1px solid #d1d5db; border-radius: 5px;
        padding: 3px 6px; background: #fff; min-width: 0;
      }
      .summary { color: #6b7280; font-size: 11px; margin-bottom: 6px; }
      .list { list-style: none; margin: 0 0 8px; padding: 0; max-height: 148px; overflow: auto; border: 1px solid #eef2f6; border-radius: 6px; }
      .list li { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-bottom: 1px solid #f1f5f9; }
      .list li:last-child { border-bottom: none; }
      .list .seek {
        border: none; background: none; padding: 0; cursor: pointer;
        font: 11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
        color: #0f766e; font-variant-numeric: tabular-nums;
      }
      .list .seek:hover { text-decoration: underline; }
      .list .kind { color: #6b7280; font-size: 11px; }
      .list .del {
        margin-left: auto; border: none; background: none; cursor: pointer;
        color: #9ca3af; font-size: 14px; line-height: 1; padding: 0 2px;
      }
      .list .del:hover { color: #b91c1c; }
      .list .empty { color: #9ca3af; font-size: 11px; padding: 8px; text-align: center; }
      .foot { display: flex; gap: 6px; }
      .foot button { flex: 1; }
      .toast {
        margin-top: 8px; font-size: 11px; color: #92400e;
        background: #fffbeb; border: 1px solid #fde68a; border-radius: 5px;
        padding: 4px 6px; display: none;
      }
      .toast.show { display: block; }
    </style>
    <div class="hud">
      <header class="hud-head">
        <span class="dot"></span>
        <b>打点辅助</b>
        <span class="sid"></span>
        <span class="spacer"></span>
        <button type="button" data-act="collapse" title="收起 / 展开（Alt+H 隐藏整个浮层）">–</button>
      </header>
      <div class="hud-body">
        <div class="time"><span class="t">0.00</span><span>s</span><span class="hint">时间取自主视频</span></div>
        <div class="btns">
          <button type="button" class="act" data-act="mark">打点 <kbd>Alt+M</kbd></button>
          <button type="button" class="act" data-act="start">循环起 <kbd>Alt+[</kbd></button>
          <button type="button" class="act" data-act="end">循环止 <kbd>Alt+]</kbd></button>
          <button type="button" class="act" data-act="undo">撤销 <kbd>Alt+Z</kbd></button>
        </div>
        <div class="form">
          <label>手别
            <select data-role="hand"><option>R</option><option>L</option><option>B</option></select>
          </label>
          <label>类型
            <input data-role="type" list="ie-marker-types" value="其他" maxlength="12">
            <datalist id="ie-marker-types">
              <option>拿取</option><option>放置</option><option>走动</option><option>移物</option>
              <option>装配</option><option>粘贴</option><option>涂</option><option>按</option>
              <option>压</option><option>抬</option><option>推</option><option>拉</option>
              <option>插</option><option>拔</option><option>目检</option><option>点检</option>
              <option>检测</option><option>清洁</option><option>扫描</option><option>翻转</option>
              <option>拆</option><option>转身</option><option>弯腰</option><option>等待</option>
              <option>机器自动</option><option>伸手</option><option>握取</option><option>定位</option>
              <option>使用</option><option>放手</option><option>寻找</option><option>发现</option>
              <option>选择</option><option>持住</option><option>其他</option>
            </datalist>
          </label>
          <label class="wide">描述前缀
            <input data-role="prefix" value="打点" maxlength="16">
          </label>
        </div>
        <div class="summary"></div>
        <ul class="list"></ul>
        <div class="foot">
          <button type="button" class="act primary" data-act="export">导出 CSV <kbd>Alt+E</kbd></button>
          <button type="button" class="act" data-act="clear">清空</button>
        </div>
        <div class="toast" role="status"></div>
      </div>
    </div>
  `;

  function ensureHud() {
    if (host) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;

    els = {
      hud: root.querySelector('.hud'),
      sid: root.querySelector('.sid'),
      time: root.querySelector('.time .t'),
      summary: root.querySelector('.summary'),
      list: root.querySelector('.list'),
      toast: root.querySelector('.toast'),
      hand: root.querySelector('[data-role="hand"]'),
      type: root.querySelector('[data-role="type"]'),
      prefix: root.querySelector('[data-role="prefix"]'),
      head: root.querySelector('.hud-head'),
    };

    bindHud();
    void restoreHudState();
    tickTimer = setInterval(tick, 200);
    tick();
    updateStationLabel();
    renderMarks();
    host.dataset.ready = '1';
  }

  function destroyHud() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    host?.remove();
    host = null;
    root = null;
    els = {};
    video = null;
  }

  async function restoreHudState() {
    const stored = await chrome.storage.local.get([COLLAPSED_KEY, POS_KEY]);
    collapsed = stored[COLLAPSED_KEY] === true;
    els.hud.classList.toggle('collapsed', collapsed);
    els.hud.querySelector('[data-act="collapse"]').textContent = collapsed ? '+' : '–';

    const pos = stored[POS_KEY];
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      els.hud.style.left = `${Math.max(0, pos.left)}px`;
      els.hud.style.top = `${Math.max(0, pos.top)}px`;
      els.hud.style.right = 'auto';
      els.hud.style.bottom = 'auto';
    }
  }

  function bindHud() {
    root.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'collapse') toggleCollapsed();
      else if (act === 'mark') addMark('point');
      else if (act === 'start') addMark('cycle-start');
      else if (act === 'end') addMark('cycle-end');
      else if (act === 'undo') undoMark();
      else if (act === 'export') exportCsv();
      else if (act === 'clear') clearMarks();
    });

    // 拖动（只从标题栏起拖，按钮除外）
    els.head.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      const rect = els.hud.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      els.hud.style.left = `${rect.left}px`;
      els.hud.style.top = `${rect.top}px`;
      els.hud.style.right = 'auto';
      els.hud.style.bottom = 'auto';

      const move = (ev) => {
        const left = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - offsetX));
        const top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offsetY));
        els.hud.style.left = `${left}px`;
        els.hud.style.top = `${top}px`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const r = els.hud.getBoundingClientRect();
        void chrome.storage.local.set({ [POS_KEY]: { left: r.left, top: r.top } });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  function toggleCollapsed() {
    collapsed = !collapsed;
    els.hud.classList.toggle('collapsed', collapsed);
    els.hud.querySelector('[data-act="collapse"]').textContent = collapsed ? '+' : '–';
    void chrome.storage.local.set({ [COLLAPSED_KEY]: collapsed });
  }

  function tick() {
    if (!video || !video.isConnected) video = findVideo();
    if (!els.time) return;
    els.time.textContent = video ? (video.currentTime || 0).toFixed(2) : '—';
  }

  function updateStationLabel() {
    if (els.sid) els.sid.textContent = stationId ? `工位 ${stationId}` : '';
    if (host) host.dataset.station = stationId ?? '';
  }

  function toast(message) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast?.classList.remove('show');
    }, 2200);
  }

  // ───────────────────────── 标记 ─────────────────────────

  const KIND_LABEL = {
    point: '打点',
    'cycle-start': '循环起',
    'cycle-end': '循环止',
  };

  function addMark(kind) {
    if (!video) {
      toast('未检测到工作台视频——请先载入视频');
      return;
    }
    if (!Number.isFinite(video.currentTime)) return;
    const t = round2(video.currentTime);
    marks.push({ id: uid(), t, kind, at: Date.now() });
    if (marks.length > MARKS_LIMIT) marks = marks.slice(-MARKS_LIMIT);
    void saveMarks();
    renderMarks();
    toast(`${KIND_LABEL[kind]} ${t.toFixed(2)}s`);
  }

  function undoMark() {
    if (marks.length === 0) {
      toast('没有可撤销的标记');
      return;
    }
    const removed = marks.pop();
    void saveMarks();
    renderMarks();
    toast(`已撤销 ${removed.t.toFixed(2)}s`);
  }

  function removeMark(id) {
    marks = marks.filter((m) => m.id !== id);
    void saveMarks();
    renderMarks();
  }

  function clearMarks() {
    if (marks.length === 0) return;
    if (!window.confirm(`清空工位 ${stationId} 的全部打点标记？`)) return;
    marks = [];
    void saveMarks();
    renderMarks();
    toast('已清空本工位标记');
  }

  function sortedMarks() {
    return [...marks].sort((a, b) => a.t - b.t);
  }

  function buildSegments() {
    const ordered = sortedMarks();
    const cycles = [];
    let start = null;
    for (const m of ordered) {
      if (m.kind === 'cycle-start') {
        start = m.t;
      } else if (m.kind === 'cycle-end' && start !== null && m.t > start) {
        cycles.push([start, m.t]);
        start = null;
      }
    }
    if (cycles.length > 0) return cycles;

    const segments = [];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const a = ordered[i].t;
      const b = ordered[i + 1].t;
      if (b > a) segments.push([a, b]);
    }
    return segments;
  }

  function cycleStats() {
    const segments = buildSegments();
    const total = round2(segments.reduce((acc, [a, b]) => acc + (b - a), 0));
    return { count: segments.length, total };
  }

  function renderMarks() {
    if (!els.list) return;
    els.list.textContent = '';
    const ordered = sortedMarks();

    if (ordered.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = '还没有标记：载入视频后按 Alt+M 打点';
      els.list.appendChild(empty);
    } else {
      for (const m of ordered) {
        const li = document.createElement('li');

        const seek = document.createElement('button');
        seek.type = 'button';
        seek.className = 'seek';
        seek.textContent = `${m.t.toFixed(2)}s`;
        seek.title = '跳转到该时间';
        seek.addEventListener('click', () => {
          if (video) video.currentTime = m.t;
        });

        const kind = document.createElement('span');
        kind.className = 'kind';
        kind.textContent = KIND_LABEL[m.kind] ?? m.kind;

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.textContent = '×';
        del.title = '删除该标记';
        del.addEventListener('click', () => removeMark(m.id));

        li.append(seek, kind, del);
        els.list.appendChild(li);
      }
    }

    const stats = cycleStats();
    const mode = marks.some((m) => m.kind === 'cycle-start' || m.kind === 'cycle-end')
      ? '循环对'
      : '相邻间隔';
    els.summary.textContent = `标记 ${marks.length} · ${mode}可导出 ${stats.count} 段 · 合计 ${stats.total.toFixed(2)}s`;
    if (host) host.dataset.marks = String(marks.length);
  }

  // ───────────────────────── 导出 ─────────────────────────

  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportCsv() {
    const segments = buildSegments();
    if (segments.length === 0) {
      toast('至少需要两个打点，或一对完整的循环起/止');
      return;
    }

    const hand = els.hand?.value || 'R';
    const type = (els.type?.value || '其他').trim() || '其他';
    const prefix = (els.prefix?.value || '打点').trim() || '打点';

    const rows = [['序号', '手别', '类型', '描述', '时长s']];
    segments.forEach(([a, b], index) => {
      rows.push([index + 1, hand, type, `${prefix} ${index + 1}`, round2(b - a).toFixed(2)]);
    });

    const csv = `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`;
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const safeStation = (stationId || 'station').replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `${safeStation}-打点-${stamp}.csv`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    toast(`已导出 ${segments.length} 段 · ${filename}`);
  }

  // ───────────────────────── 快捷键 ─────────────────────────

  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
  }

  function onKeydown(event) {
    if (!host) return;
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.getModifierState?.('AltGraph')) return;
    if (isTypingTarget(event.target)) return;

    let handled = true;
    if (event.code === 'KeyM') addMark('point');
    else if (event.code === 'BracketLeft') addMark('cycle-start');
    else if (event.code === 'BracketRight') addMark('cycle-end');
    else if (event.code === 'KeyZ') undoMark();
    else if (event.code === 'KeyE') exportCsv();
    else if (event.code === 'KeyH') {
      host.hidden = !host.hidden;
      toast(host.hidden ? '浮层已隐藏：Alt+H 恢复' : '浮层已显示');
    } else {
      handled = false;
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  window.addEventListener('keydown', onKeydown, true);

  // ───────────────────────── 路由同步 ─────────────────────────

  async function syncRoute() {
    const sid = getStationId();

    if (!sid) {
      destroyHud();
      stationId = null;
      marks = [];
      return;
    }

    if (sid === stationId) {
      ensureHud();
      return;
    }

    stationId = sid;
    marks = [];
    const loaded = await loadMarks(sid);
    if (stationId !== sid) return; // 加载期间又切了工位
    marks = loaded;
    ensureHud();
    updateStationLabel();
    renderMarks();
    toast(`已载入工位 ${sid} 的 ${marks.length} 个标记`);
  }

  window.addEventListener('hashchange', () => {
    void syncRoute();
  });
  window.addEventListener('popstate', () => {
    void syncRoute();
  });

  // ───────────────────────── 与 popup 通信 ─────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;

    if (message.type === 'ping') {
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'status') {
      sendResponse({
        ok: true,
        stationId,
        marks: marks.length,
        visible: Boolean(host && !host.hidden),
        hasVideo: Boolean(video && video.isConnected),
        time: video ? video.currentTime : null,
      });
      return;
    }

    if (message.type === 'toggle') {
      if (!stationId) {
        sendResponse({ ok: false, reason: 'not-workbench' });
        return;
      }
      if (!host) ensureHud();
      host.hidden = !host.hidden;
      sendResponse({ ok: true, visible: !host.hidden });
    }
  });

  void syncRoute();
})();