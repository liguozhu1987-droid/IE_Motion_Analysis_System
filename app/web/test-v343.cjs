/**
 * v3.43 P1 优化 · AI 自动分解专项 UI 测试
 *
 * 覆盖（用户「其他的按P1来进行优化」）：
 *   T1 操作区 ROI 标定：面板/拖拽框选/保存到工位（PATCH /stations roi）/清除标定
 *   T2 浪费规则直判列：候选表「提示」列渲染（等待/双手不平衡为规则输出，合成视频不强制有值）
 *   T3 证据帧：行内「帧」按钮 → 三帧弹窗（起始/中间/结束，dataURL 内存展示）
 *   T4 导出候选 JSON：按钮可用、点击无页面异常（评测基线入口）
 *
 * 前置：API(3001) + Vite dev(5173)；固件 test-fixtures/aiseg-8s.mp4。
 * 分析在 headless 软渲染下慢约 10 倍（8s 视频约 1-2 分钟），预算 240s。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SID = 'L01-ST01';

let pass = 0;
let fail = 0;
const errors = [];
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 240) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed');

  /* 前置：确保 L01-ST01 roi 为未标定态（测试自建自清，不依赖残留） */
  await fetch(`${API}/stations/${encodeURIComponent(SID)}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + login.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ roi: null }),
  });

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errors.push('[js] ' + String(e.message).slice(0, 200)));

  /* ROI 保存/清除请求审计 */
  const roiPatches = [];
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && /\/api\/stations\//.test(req.url())) roiPatches.push(req.url());
  });

  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  await page.goto(`${WEB}/?b=${Date.now()}#/ai-segment/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.aip-head', { timeout: 30000 });
  await sleep(1200);

  console.log('\n--- T1. 操作区 ROI 标定 ---');
  const roiBtnText0 = await page.$eval('.aip-acts button:nth-of-type(1)', () => '').catch(() => null);
  // 载入固件视频（先载视频再开面板，覆盖层需要 videoWidth）
  const fixture = path.join(__dirname, 'test-fixtures', 'aiseg-8s.mp4');
  if (!fs.existsSync(fixture)) {
    console.log('  SKIP 缺少固件，ROI/证据帧/分析相关断言跳过');
    await browser.close();
    process.exit(fail > 0 ? 1 : 0);
  }
  const fileInput = await page.$('.aip-acts input[type=file]');
  await fileInput.uploadFile(fixture);
  await sleep(2000);

  /* 打开面板 */
  const roiBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.aip-acts button')].find((b) => /操作区/.test(b.textContent)));
  await roiBtn.asElement().click();
  await page.waitForSelector('.aip-roi-panel', { timeout: 5000 });
  ok('T1 面板打开，显示「未标定」默认值', (await page.$eval('.aip-roi-panel', (e) => e.textContent)).includes('未标定'));

  /* 拖拽框选：在视频内容框中部拖一块 */
  const layer = await page.$('.aip-roi-layer');
  ok('T1 覆盖层渲染（对齐视频内容框）', layer !== null);
  const lb = await layer.boundingBox();
  /* v3.44 ROI 面板加高（功能区子区区段）后左下角被面板遮挡（z-index 4 > layer 3），
     pointerdown 须落在面板外——改走右半区 (0.50,0.15)→(0.90,0.55)，期望 roi x≈0.6/w≈0.35 */
  const x0 = lb.x + lb.width * 0.60, y0 = lb.y + lb.height * 0.15;
  const x1 = lb.x + lb.width * 0.95, y1 = lb.y + lb.height * 0.55;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  const dragMsg = await page.$eval('.aip-roi-panel', (e) => e.textContent);
  ok('T1 拖拽框选生效（已框选提示）', dragMsg.includes('已框选'), dragMsg.slice(0, 80));

  /* 保存到工位 → PATCH 落库（轮询 300ms：headless swiftshader 下 rAF 节流会让默认 raf 轮询失灵——v344 实锤） */
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.aip-roi-acts button')].find((x) => /保存到工位/.test(x.textContent));
    b.click();
  });
  const savedMsg = await page.waitForFunction(() => {
    const t = (document.querySelector('.aip-roi-msg') || {}).textContent || '';
    return /已保存|保存失败/.test(t) ? t : null;
  }, { timeout: 10000, polling: 300 }).then((h) => h.jsonValue()).catch(() => null);
  ok('T1 保存到工位成功（面板消息）', savedMsg !== null && savedMsg.includes('已保存'), savedMsg);
  const st1 = await (await fetch(`${API}/stations/${encodeURIComponent(SID)}`, { headers: { Authorization: 'Bearer ' + login.accessToken } })).json();
  let roiOk = false;
  try { const j = JSON.parse(st1.roi); roiOk = Math.abs(j.x - 0.6) < 0.02 && Math.abs(j.w - 0.35) < 0.02; } catch { /* noop */ }
  ok('T1 roi 列落库正确（x≈0.6/w≈0.35）', roiOk, st1.roi);
  const btnTxt = await page.evaluate(() => [...document.querySelectorAll('.aip-acts button')].find((b) => /操作区/.test(b.textContent)).textContent);
  ok('T1 工具栏按钮显示「已标定」', btnTxt.includes('已标定'), btnTxt);

  /* 清除标定还原 */
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.aip-roi-acts button')].find((x) => /清除标定/.test(x.textContent));
    b.click();
  });
  await page.waitForFunction(() => (document.querySelector('.aip-roi-msg') || {}).textContent?.includes('清除'), { timeout: 10000, polling: 300 });
  const st2 = await (await fetch(`${API}/stations/${encodeURIComponent(SID)}`, { headers: { Authorization: 'Bearer ' + login.accessToken } })).json();
  ok('T1 清除标定（roi 回 null）', st2.roi === null || st2.roi === undefined, st2.roi);
  /* 测试收尾：恢复未标定态 */
  await fetch(`${API}/stations/${encodeURIComponent(SID)}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + login.accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ roi: null }),
  });

  console.log('\n--- T2. 真实分析 + 浪费提示列 ---');
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.aip-acts button')].find((x) => /操作区/.test(x.textContent));
    if (b) b.click(); // 关面板再分析
  });
  await sleep(300);
  await page.click('.aip-acts button.primary');
  let finished = false;
  for (let i = 0; i < 120; i += 1) {
    await sleep(2000);
    const running = (await page.$$eval('.ais-overlay', (e) => e.length)) > 0;
    const stuck = (await page.$('.aip-error')) !== null;
    if (!running || stuck) { finished = true; break; }
  }
  ok('T2 分析结束（未挂死）', finished);
  const errText = await page.$eval('.aip-error', (e) => e.textContent.trim()).catch(() => '');
  ok('T2 无分析失败', errText === '', errText);
  const heads = await page.$$eval('.ais-table thead th', (ths) => ths.map((t) => t.textContent.trim()));
  ok('T2 候选表含「提示」列（浪费规则直判）', heads.includes('提示'), heads.join('|'));
  ok('T2 候选表含「帧」列（证据帧入口）', heads.includes('帧'), heads.join('|'));

  console.log('\n--- T3. 证据帧 ---');
  const frameBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.ais-table tbody button')].find((b) => /帧/.test(b.textContent)));
  const hasFrameBtn = Boolean(frameBtn.asElement());
  if (hasFrameBtn) {
    await frameBtn.asElement().click();
    const appeared = await page.waitForSelector('.aip-evi', { timeout: 20000 }).then(() => true).catch(() => false);
    ok('T3 证据帧弹窗打开', appeared);
    if (appeared) {
      const gotUrls = await page.waitForFunction(() =>
        document.querySelectorAll('.aip-evi-grid img').length === 3 &&
        [...document.querySelectorAll('.aip-evi-grid img')].every((i) => i.src.startsWith('data:image/jpeg')),
      { timeout: 30000 }).then(() => true).catch(() => false);
      ok('T3 三帧 JPEG dataURL 全部生成', gotUrls);
      const caps = await page.$$eval('.aip-evi-grid figcaption', (cs) => cs.map((c) => c.textContent.trim()));
      ok('T3 起始/中间/结束三帧标注', caps.length === 3 && caps[0].startsWith('起始') && caps[2].startsWith('结束'), caps.join('|'));
      await page.click('.aip-evi-head button');
      await sleep(300);
      ok('T3 弹窗可关闭', (await page.$('.aip-evi')) === null);
    }
  } else {
    ok('T3 存在候选行（有帧按钮）', false, '候选为空');
  }

  console.log('\n--- T4. 导出候选 JSON ---');
  const expEnabled = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.aip-side-head button')].find((x) => /导出候选JSON/.test(x.textContent));
    return b ? !b.disabled : false;
  });
  ok('T4 导出按钮可用（分析后）', expEnabled);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.aip-side-head button')].find((x) => /导出候选JSON/.test(x.textContent));
    b.click();
  });
  await sleep(800);
  ok('T4 导出点击无页面异常', errors.length === 0, errors.join('；'));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败${errors.length ? ` / 页面异常 ${errors.length}：${errors[0]}` : ''}`);
  await browser.close();
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
