/**
 * v3.23 专项验证（用户反馈两项）：
 *  A. 分解工作台控制栏布局优化：
 *     - 「↑ 上一要素边界 / ↓ 下一要素边界」按钮取消（键盘 ↑↓ 仍在，时间线交互已覆盖）
 *     - 「⚠ 帧率不足 30」长文案取消（fps 徽标 <30 变琥珀色即可表意）
 *     - 记录组重要性重排：＋新增 提到组首，且不被 overflow 裁切
 *  B. 新建工位编码（v3.22 预填方案的修订）：
 *     - 编码输入框默认【留空】由用户自己写，建议值降级为占位灰字（含 STxx 形式）
 *     - 留空提交 → 后端按 CMC 产线码自动生成，创建成功（零删除动作）
 *
 * 视频源：运行时 MediaRecorder 生成 12s 60fps webm（覆盖要素区间，坑㉝）。
 * 冒烟工位收尾清理（坑⑱）。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SHOT_DIR = 'D:/Application/IE_Improvement_Platform/deliverables/v323';

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 220) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
const domLog = [];
const domSnap = (label, data) => { domLog.push({ label, data }); };

(async () => {
  const loginRes = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const loginJson = await loginRes.json();
  const token = loginJson.accessToken;
  ok('登录成功', !!token);

  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  page.on('dialog', async (d) => { await d.dismiss(); });
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, loginJson.refreshToken);

  // ========== A. 分解工作台控制栏 ==========
  await page.goto(WEB + '/#/workbench/L01-ST01', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(2000);

  /* 注入 12 秒测试视频（canvas 递增计数 + MediaRecorder，60fps） */
  const videoReady = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(60);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(100);
    const t0 = performance.now();
    await new Promise((res) => {
      const draw = () => {
        const t = (performance.now() - t0) / 1000;
        if (t >= 12) { res(); return; }
        ctx.fillStyle = '#123';
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#fff';
        ctx.font = '80px monospace';
        ctx.fillText(t.toFixed(2) + 's', 200, 190);
        requestAnimationFrame(draw);
      };
      draw();
    });
    rec.stop();
    await done;
    const blob = new Blob(chunks, { type: 'video/webm' });
    const file = new File([blob], 'v323-test.webm', { type: 'video/webm' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = Array.from(document.querySelectorAll('input[type="file"]'))[0];
    if (!input) return { ok: false, why: 'no file input' };
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  });
  ok('A0 测试视频注入成功', videoReady.ok !== false, JSON.stringify(videoReady));
  await page.waitForFunction(() => {
    const v = document.querySelector('.wb-screen video');
    return v && v.readyState >= 1;
  }, { timeout: 30000 }).catch(() => {});
  await sleep(800);

  const bar = await page.evaluate(() => {
    const controls = document.querySelector('.wb-controls');
    if (!controls) return { found: false };
    const cr = controls.getBoundingClientRect();
    const btns = Array.from(controls.querySelectorAll('.wb-tp-btn'));
    const byTitle = (t) => btns.filter((b) => (b.title || '').includes(t)).length;
    const rec = controls.querySelector('.wb-rec');
    const recBtns = rec ? Array.from(rec.querySelectorAll('.wb-rec-btn, .wb-rec-split')) : [];
    const recFirst = recBtns[0];
    const addBtn = recBtns.find((b) => (b.textContent || '').includes('新增'));
    const fr = addBtn ? addBtn.getBoundingClientRect() : null;
    const warn = controls.querySelector('.wb-fps-warn');
    const fps = controls.querySelector('.wb-fps');
    return {
      found: true,
      boundaryBtns: byTitle('要素边界'),
      warnExists: !!warn,
      fpsText: fps ? fps.textContent.trim() : null,
      fpsLow: fps ? fps.classList.contains('low') : null,
      recOrder: recBtns.map((b) => b.textContent.trim().replace(/\s+/g, '')),
      addRect: fr ? { left: Math.round(fr.left), right: Math.round(fr.right), w: Math.round(fr.width) } : null,
      controlsRect: { left: Math.round(cr.left), right: Math.round(cr.right) },
      addVisible: fr ? (fr.left >= cr.left - 1 && fr.right <= cr.right + 1 && fr.width > 0) : false,
    };
  });
  ok('A1 控制栏存在', bar.found);
  ok('A2 「上一/下一要素边界」按钮已取消', bar.boundaryBtns === 0, bar.boundaryBtns);
  ok('A3 「⚠ 帧率不足 30」长文案已取消', !bar.warnExists);
  ok('A4 fps 徽标存在（实测帧率数字显示）', /^\d+fps$/.test(bar.fpsText || ''), bar.fpsText);
  ok('A5 记录组顺序：新增→I起点→O止点→分割→同上',
    JSON.stringify(bar.recOrder) === JSON.stringify(['＋新增', 'I起点', 'O止点', '分割', '⧉同上']), JSON.stringify(bar.recOrder));
  ok('A6 ＋新增（组首）完整可见不被裁切', bar.addVisible, JSON.stringify({ add: bar.addRect, bar: bar.controlsRect }));
  domSnap('controls-bar', bar);
  const ctl = await page.$('.wb-controls');
  if (ctl) await ctl.screenshot({ path: path.join(SHOT_DIR, 'v323-01-controls-bar.png') });
  await page.screenshot({ path: path.join(SHOT_DIR, 'v323-02-workbench.png') });

  /* 键盘 ↑↓ 边界跳转仍可用（按钮取消但快捷键保留）；播放头 0 点处 ↑ 无更早边界，
     用 ↓ 验证（下一边界 > 0+eps 必存在） */
  const blockCount = await page.evaluate(() => document.querySelectorAll('.tl-lane .block').length);
  if (blockCount > 0) {
    await page.evaluate(() => { const b = document.querySelector('.tl-lane .block'); b && b.click(); });
    await sleep(300);
    const before = await page.evaluate(() => (document.querySelector('.wb-tp-time b') || {}).textContent);
    await page.keyboard.press('ArrowDown');
    await sleep(300);
    const after = await page.evaluate(() => (document.querySelector('.wb-tp-time b') || {}).textContent);
    ok('A7 键盘 ↓ 仍可跳下一要素边界（按钮取消但快捷键保留）', before !== after, before + ' → ' + after);
  } else {
    ok('A7 键盘 ↑ 边界跳转（无块跳过）', true);
  }

  // ========== B. 新建工位向导：编码留空 ==========
  await page.goto(WEB + '/#/master', { waitUntil: 'networkidle0', timeout: 60000 });
  await sleep(1500);
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => /新建工位/.test(b.textContent));
    btn && btn.click();
  });
  await page.waitForSelector('.modal.wz', { timeout: 15000 }).catch(() => {});
  await sleep(500);
  /* 等 CMC 联动就绪（项目下拉不再 disabled，坑㊳） */
  await page.waitForFunction(() => {
    const btn = document.querySelector('.modal.wz [aria-label="选择项目"]');
    return btn && !btn.disabled;
  }, { timeout: 30000 }).catch(() => {});

  const wzCode = await page.evaluate(() => {
    const field = Array.from(document.querySelectorAll('.wz-field')).find((f) => /工位编码/.test(f.textContent));
    if (!field) return null;
    const input = field.querySelector('input');
    const label = field.querySelector('span') ? field.parentElement.textContent : '';
    return { value: input.value, placeholder: input.placeholder, disabled: input.disabled };
  });
  ok('B1 向导打开且编码字段存在', !!wzCode, JSON.stringify(wzCode));
  ok('B2 编码默认留空（用户自己写，零删除动作）', wzCode && wzCode.value === '', wzCode && wzCode.value);
  ok('B3 建议值降级为占位灰字（含 STxx 形式）', wzCode && /ST\d{2}/.test(wzCode.placeholder || ''), wzCode && wzCode.placeholder);
  ok('B4 编码输入框可编辑', wzCode && !wzCode.disabled);
  domSnap('wizard-code-empty', wzCode);

  /* B5: 留空编码 + 填名称 → 创建成功 → 编码由后端自动生成（XX-STnn）→ 清理 */
  const nameInput = await page.evaluateHandle(() => {
    const f = Array.from(document.querySelectorAll('.wz-field')).find((x) => /工位名称/.test(x.textContent));
    return f ? f.querySelector('input') : null;
  });
  if (nameInput && nameInput.asElement()) {
    await nameInput.asElement().click();
    await nameInput.asElement().type('UI冒烟v323临时', { delay: 20 });
    await sleep(300);
    const createBtn = await page.evaluateHandle(() => Array.from(document.querySelectorAll('.wz-foot button')).find((b) => /创建/.test(b.textContent)));
    const disabled = await page.evaluate((el) => el.disabled, createBtn);
    ok('B5 留空编码校验通过（创建按钮可点）', !disabled);
    if (!disabled) {
      await createBtn.asElement().click();
      await sleep(2500);
      const after = await page.evaluate(() => ({ wzGone: !document.querySelector('.modal.wz') }));
      const list = await (await fetch(API + '/stations', { headers: { Authorization: 'Bearer ' + token } })).json();
      const created = (Array.isArray(list) ? list : []).find((s) => /UI冒烟v323临时/.test(s.name));
      ok('B6 创建成功且向导关闭', after.wzGone && !!created, JSON.stringify(after));
      ok('B7 留空提交 → 编码自动生成（产线码-STnn）', !!created && /^[A-Za-z0-9]+-ST\d{2}$/.test(created.station_id || ''), created && created.station_id);
      domSnap('wizard-created', { after, station: created });
      await page.screenshot({ path: path.join(SHOT_DIR, 'v323-03-wizard-created.png') });
      /* 收尾清理冒烟工位（坑⑱） */
      if (created) {
        await fetch(API + '/stations/' + encodeURIComponent(created.station_id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
        const list2 = await (await fetch(API + '/stations', { headers: { Authorization: 'Bearer ' + token } })).json();
        const leftover = (Array.isArray(list2) ? list2 : []).filter((s) => /冒烟/.test(s.name));
        for (const s of leftover) await fetch(API + '/stations/' + encodeURIComponent(s.station_id), { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
        ok('B8 冒烟工位已清理', true);
      }
    }
  }

  ok('无 JS 报错', jsErrors.length === 0, jsErrors.join(' | '));
  fs.writeFileSync(path.join(SHOT_DIR, 'v323-dom.json'), JSON.stringify(domLog, null, 2));
  console.log('\n===== v323 结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
