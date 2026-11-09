/**
 * v3.28 播放器格式兼容 + 校验横幅视觉 专项验证（用户三项需求）：
 *  ① 格式兼容：原生可播（webm）直播不上传；AVI/MKV 直播失败 → 自动上传后端 ffmpeg 转码 → 播放终态 MP4
 *  ② 校验横幅：三态底色/边框/对比度（计算样式断言，此前后端三个 banner 类从未定义=透明底）+ × 关闭交互
 *  ③ API 直传：MP4 直通不转码、播放地址 200(video/mp4)+Range 206+无 token 401、AVI 转码、垃圾文件 503 明确报错
 * 夹具：fixtures/v328/{sample.avi(mpeg4), sample.mkv(h264-in-matroska), sample.mp4(h264)}——本地 ffmpeg 生成
 */
const puppeteer = require('puppeteer-core');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const ORIGIN = 'http://localhost:3001';
const WEB = 'http://localhost:5173';
const fs = require('fs');
const path = require('path');
const SHOT_DIR = path.join(__dirname, '..', 'deliverables', 'v328');
const FIX_DIR = path.join(__dirname, 'fixtures', 'v328');
fs.mkdirSync(SHOT_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (detail != null ? '  → ' + String(detail).slice(0, 220) : '')); }
};

/** 上传文件（Node 侧 FormData） */
async function uploadFixture(filename, mime, garbage = false) {
  const fd = new FormData();
  const blob = garbage
    ? new Blob([Buffer.from('this-is-not-a-video-'.repeat(50))], { type: mime })
    : new Blob([fs.readFileSync(path.join(FIX_DIR, filename))], { type: mime });
  fd.append('file', blob, filename);
  return fd;
}

/** 页面内注入文件（base64 → File → DataTransfer → 文件输入框 change） */
async function injectFile(page, filename, mime) {
  const b64 = fs.readFileSync(path.join(FIX_DIR, filename)).toString('base64');
  return page.evaluate(async ({ b64, name, mime }) => {
    try {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
      const file = new File([buf], name, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('.wb-top-acts input[type=file]');
      if (!input) return false;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }, { b64, name: filename, mime });
}

/** MediaRecorder 现场录制 8s webm（原生可播格式，验证"直播不走服务器"） */
async function injectRecordedWebm(page) {
  return page.evaluate(async () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.start();
      const t0 = performance.now();
      await new Promise((resolve) => {
        const draw = () => {
          const el = performance.now() - t0;
          ctx.fillStyle = `hsl(${el / 8}, 60%, 50%)`;
          ctx.fillRect(0, 0, 320, 180);
          if (el < 8000) requestAnimationFrame(draw); else resolve();
        };
        requestAnimationFrame(draw);
      });
      rec.stop();
      await new Promise((r) => { rec.onstop = r; });
      const blob = new Blob(chunks, { type: 'video/webm' });
      const file = new File([blob], 'v328-sample.webm', { type: 'video/webm' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector('.wb-top-acts input[type=file]');
      if (!input) return false;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  });
}

const videoState = (page) => page.evaluate(() => {
  const v = document.querySelector('video');
  return v ? { paused: v.paused, t: v.currentTime, ready: v.readyState, src: v.src.slice(0, 90) } : null;
});
const upCalls = (page) => page.evaluate(() => window.__upCalls ?? -1);
const clickText = async (page, text) => {
  const box = await page.evaluate((t) => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === t);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, text);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
};
/** 等某个横幅出现，返回其类名与计算样式；kind 指定时只取该类横幅 */
const bannerInfo = (page, kind) => page.evaluate((k) => {
  const sel = k ? `.wb-toast-banners .${k}` : '.wb-toast-banners .wb-banner';
  const b = document.querySelector(sel);
  if (!b) return null;
  const cs = getComputedStyle(b);
  return {
    cls: b.className,
    text: (b.textContent || '').slice(0, 120),
    bg: cs.backgroundColor, color: cs.color, borderW: cs.borderTopWidth, radius: cs.borderRadius, shadow: cs.boxShadow !== 'none',
  };
}, kind ?? null);

(async () => {
  for (const f of ['sample.avi', 'sample.mkv', 'sample.mp4']) {
    if (!fs.existsSync(path.join(FIX_DIR, f))) { console.error('缺少夹具 ' + f + '（请用 ffmpeg 生成）'); process.exit(1); }
  }
  const login = await (await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  })).json();
  const auth = { Authorization: 'Bearer ' + login.accessToken };

  // ==================== ① API 层：上传/转码/播放端点 ====================
  console.log('== ① API：videos 端点 ==');
  const cap = await (await fetch(API + '/videos/capabilities', { headers: auth })).json();
  ok('capabilities 报 ffmpeg 可用', cap.ffmpeg === true, JSON.stringify(cap));

  const r1 = await fetch(API + '/videos/upload', { method: 'POST', headers: auth, body: await uploadFixture('sample.mp4', 'video/mp4') });
  const j1 = await r1.json().catch(() => ({}));
  ok('MP4 直传直通（不转码）', [200, 201].includes(r1.status) && j1.transcoded === false, `${r1.status} ${JSON.stringify(j1).slice(0, 200)}`);
  ok('MP4 探测容器/编码正确', /mp4|mov/.test(j1.probe?.container || '') && j1.probe?.videoCodec === 'h264', JSON.stringify(j1.probe));
  ok('直通返回播放地址', typeof j1.url === 'string' && /\/api\/videos\/file\/[0-9a-f-]{36}\.mp4$/.test(j1.url), j1.url);

  if (j1.url) {
    const p1 = await fetch(ORIGIN + j1.url + '?token=' + encodeURIComponent(login.accessToken));
    ok('播放地址 200 + video/mp4', p1.status === 200 && (p1.headers.get('content-type') || '').includes('video/mp4'), `${p1.status} ${p1.headers.get('content-type')}`);
    ok('播放地址有实际内容', (await p1.arrayBuffer()).byteLength > 1000);

    const rg = await fetch(ORIGIN + j1.url + '?token=' + encodeURIComponent(login.accessToken), { headers: { Range: 'bytes=0-99' } });
    ok('Range 206（拖动进度条依赖）', rg.status === 206, rg.status);

    const nt = await fetch(ORIGIN + j1.url);
    ok('无 token 401（宁缺勿错）', nt.status === 401, nt.status);
  } else {
    ok('播放地址 200 + video/mp4', false, '上传失败，跳过');
    ok('播放地址有实际内容', false, '上传失败，跳过');
    ok('Range 206（拖动进度条依赖）', false, '上传失败，跳过');
    ok('无 token 401（宁缺勿错）', false, '上传失败，跳过');
  }

  const r2 = await fetch(API + '/videos/upload', { method: 'POST', headers: auth, body: await uploadFixture('sample.avi', 'video/x-msvideo') });
  const j2 = await r2.json().catch(() => ({}));
  ok('AVI 直传自动转码', [200, 201].includes(r2.status) && j2.transcoded === true, `${r2.status} ${JSON.stringify(j2).slice(0, 200)}`);
  ok('AVI 探测容器/编码正确', /avi/.test(j2.probe?.container || '') && j2.probe?.videoCodec === 'mpeg4', JSON.stringify(j2.probe));
  if (j2.url) {
    const p2 = await fetch(ORIGIN + j2.url + '?token=' + encodeURIComponent(login.accessToken));
    const p2buf = Buffer.from(await p2.arrayBuffer());
    ok('转码产物是真 MP4（ftyp 头）', p2.status === 200 && p2buf.slice(4, 8).toString() === 'ftyp', `${p2.status} ${p2buf.slice(0, 12).toString('hex')}`);
  } else {
    ok('转码产物是真 MP4（ftyp 头）', false, '上传失败，跳过');
  }

  const r3 = await fetch(API + '/videos/upload', { method: 'POST', headers: auth, body: await uploadFixture('junk.avi', 'video/x-msvideo', true) });
  const j3 = await r3.json().catch(() => ({}));
  ok('垃圾文件 503 明确报错', r3.status === 503 && /ffmpeg|格式|转换/.test(j3.detail || ''), `${r3.status} ${String(j3.detail).slice(0, 120)}`);

  // ==================== ② UI 层 ====================
  const browser = await puppeteer.launch({ headless: 'new', executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.5 });
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
    localStorage.removeItem('wb-new-dur');
    window.__upCalls = 0;
    const orig = window.fetch;
    window.fetch = function (...args) {
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (String(u).includes('/videos/upload')) window.__upCalls += 1;
      } catch { /* 忽略 */ }
      return orig.apply(this, args);
    };
  }, login.refreshToken);
  await page.goto(WEB + '/#/workbench/L01-ST01', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.tl-lane .block', { timeout: 20000 });
  await sleep(800);

  // ---- ②-A 原生 webm 直播：不上传服务器 ----
  console.log('== ②-A 原生格式（webm）直播 ==');
  ok('录制 webm 注入成功', await injectRecordedWebm(page));
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.readyState >= 2; }, { timeout: 10000 });
  const stw = await videoState(page);
  ok('webm 直接播放（readyState≥2）', stw && stw.ready >= 2 && stw.src.startsWith('blob:'), JSON.stringify(stw));
  ok('原生格式零上传（__upCalls=0）', (await upCalls(page)) === 0, await upCalls(page));
  const beforeW = await videoState(page);
  await page.keyboard.down('KeyL');
  await sleep(600);
  const duringW = await videoState(page); // 按住期间查（松开即停是 v3.22 语义，查晚了必然 paused）
  await page.keyboard.up('KeyL');
  ok('webm 播放中 currentTime 前进', duringW && duringW.paused === false && duringW.t > beforeW.t + 0.15, `${beforeW.t} → ${duringW && duringW.t}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v328-01-native-webm.png') });
  console.log('saved v328-01-native-webm.png');

  // ---- ②-B 校验横幅：底色/对比度/关闭 ----
  console.log('== ②-B 校验横幅视觉 ==');
  ok('点击「校验」', await clickText(page, '校验'));
  await page.waitForSelector('.wb-toast-banners .wb-banner', { timeout: 8000 });
  await sleep(300);
  const bi1 = await bannerInfo(page);
  ok('校验后出现横幅', !!bi1, JSON.stringify(bi1));
  ok('横幅有实底色（修复透明底）', !!bi1 && bi1.bg !== 'rgba(0, 0, 0, 0)' && bi1.bg !== 'transparent' && bi1.bg !== 'rgb(4, 8, 13)', bi1 && bi1.bg);
  ok('横幅文字有对比色', !!bi1 && bi1.color !== 'rgba(0, 0, 0, 0)' && bi1.color !== bi1.bg, bi1 && bi1.color);
  ok('横幅有边框', !!bi1 && parseFloat(bi1.borderW) > 0, bi1 && bi1.borderW);
  const kind1 = bi1 && /banner-error/.test(bi1.cls) ? 'error' : (/banner-warn/.test(bi1.cls) ? 'warn' : 'success');
  console.log(`  · 首个横幅类型=${kind1} bg=${bi1 && bi1.bg} text=${bi1 && bi1.text}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v328-02-banner-' + kind1 + '.png') });
  console.log('saved v328-02-banner-' + kind1 + '.png');
  // × 关闭交互
  ok('点击 × 关闭横幅', await page.evaluate(() => { const x = document.querySelector('.wb-toast-banners .wb-banner-x'); if (!x) return false; x.click(); return true; }));
  await sleep(400);
  ok('关闭后横幅消失', await page.evaluate(() => !document.querySelector('.wb-toast-banners .wb-banner')));

  // ---- ②-C 制造 V3 错误 → error 红横幅 ----
  console.log('== ②-C 循环数不足 → error 横幅 ==');
  await page.evaluate(() => {
    const wrap = Array.from(document.querySelectorAll('.wb-ab-field')).find((w) => w.querySelector('span')?.textContent === '循环');
    const inp = wrap?.querySelector('input');
    if (!inp) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '10');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  ok('循环数改为 10 后点校验', await clickText(page, '校验'));
  await page.waitForFunction(() => {
    const b = document.querySelector('.wb-toast-banners .banner-error');
    return b && /V3|循环/.test(b.textContent || '');
  }, { timeout: 8000 });
  await sleep(300);
  const bi2 = await bannerInfo(page, 'banner-error');
  ok('出现 V3 error 横幅', !!bi2 && /banner-error/.test(bi2.cls) && /V3|循环/.test(bi2.text), JSON.stringify(bi2));
  ok('error 横幅同样有实底色', !!bi2 && bi2.bg !== 'rgba(0, 0, 0, 0)' && bi2.bg !== 'transparent', bi2 && bi2.bg);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v328-03-banner-error-v3.png') });
  console.log('saved v328-03-banner-error-v3.png');
  await page.evaluate(() => { document.querySelector('.wb-toast-banners .wb-banner-x')?.click(); });
  await sleep(300);
  // 恢复循环数（不提交，仅避免后续截图带红条）
  await page.evaluate(() => {
    const wrap = Array.from(document.querySelectorAll('.wb-ab-field')).find((w) => w.querySelector('span')?.textContent === '循环');
    const inp = wrap?.querySelector('input');
    if (!inp) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, '15');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);

  // ---- ②-D AVI 回退：自动上传转码 ----
  console.log('== ②-D AVI → 后端转码回退 ==');
  ok('注入 sample.avi', await injectFile(page, 'sample.avi', 'video/x-msvideo'));
  await page.waitForSelector('.wb-converting', { timeout: 10000 });
  ok('出现「正在转换」浮层（不黑屏静默）', true);
  await page.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && v.src.includes('/videos/file/') && !document.querySelector('.wb-converting');
  }, { timeout: 120000, polling: 500 });
  await sleep(600);
  ok('AVI 触发 1 次上传', (await upCalls(page)) === 1, await upCalls(page));
  const sta = await videoState(page);
  ok('转码后播放服务端 MP4', sta && sta.src.includes('/videos/file/') && sta.ready >= 2, JSON.stringify(sta));
  ok('文件名标注「已转换」', await page.evaluate(() => /已转换/.test((document.querySelector('.wb-vfile') || {}).textContent || '')));
  const beforeA = await videoState(page);
  await page.keyboard.down('KeyL');
  await sleep(700);
  const duringA = await videoState(page); // 按住期间查（松开即停）
  await page.keyboard.up('KeyL');
  ok('转码后视频可播放（currentTime 前进）', duringA && duringA.paused === false && duringA.t > beforeA.t + 0.15, `${beforeA.t} → ${duringA && duringA.t}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v328-04-avi-transcoded.png') });
  console.log('saved v328-04-avi-transcoded.png');

  // ---- ②-E MKV：新版 Chrome 原生可播 H.264-in-Matroska（实测 Chrome 155 canPlayType=maybe，播放正常）
  //      直播零上传；不能播的旧浏览器走 video onError → 与 AVI 同一条服务端转码回退链 ----
  console.log('== ②-E MKV 原生播放（新版 Chrome） ==');
  ok('注入 sample.mkv', await injectFile(page, 'sample.mkv', 'video/x-matroska'));
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v && v.src.startsWith('blob:') && v.readyState >= 2; }, { timeout: 10000 });
  await sleep(400);
  ok('MKV 原生可播（不触发上传，__upCalls 仍为 1）', (await upCalls(page)) === 1, await upCalls(page));
  const stm = await videoState(page);
  ok('MKV 直播播放（blob + readyState≥2）', stm && stm.src.startsWith('blob:') && stm.ready >= 2, JSON.stringify(stm));
  const beforeM = await videoState(page);
  await page.keyboard.down('KeyL');
  await sleep(600);
  const duringM = await videoState(page);
  await page.keyboard.up('KeyL');
  ok('MKV 播放中 currentTime 前进', duringM && duringM.paused === false && duringM.t > beforeM.t + 0.15, `${beforeM.t} → ${duringM && duringM.t}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'v328-05-mkv-native.png') });
  console.log('saved v328-05-mkv-native.png');

  ok('全程无 JS 报错', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('运行异常:', e); process.exit(1); });
