/**
 * AI 自动分解「从服务器载入」端到端验证（v3.39 P0-2）
 *
 * 覆盖四条路径：
 *  1. H.264 MP4 上传 → 免转码直通 → 视频可播
 *  2. HEVC MP4 上传 → 免转码直通（raw=1）→ 视频可播 → 能跑分析出候选
 *  3. MKV(H.264) 上传 → 服务端自动转码 → 视频可播
 *  4. 假视频文件 → .avi 直接转码失败报错；.mp4 直通后播不了 → 自动转码重试 → 报错且页面不白屏
 *
 * 用法：node test-ai-segment-upload.cjs
 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SID = 'PA10';
const REAL = path.resolve(__dirname, '..', '..', 'deliverables', 'ai-segment', 'real');
const READY_MS = Number(process.env.READY_MS || 120000);   // 上传+拉 blob+视频就绪上限
const ANALYZE_MS = Number(process.env.ANALYZE_MS || 240000); // 15s 视频分析上限

let ok = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { ok += 1; console.log('  OK   ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + '  ' + extra); }
}

async function call(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

(async () => {
  const login = await call('POST', '/auth/login', { username: 'admin', password: '123456' });
  const token = login.body && login.body.accessToken;
  check('登录成功', !!token, `status=${login.status}`);
  if (!token) process.exit(1);

  // 工位必须存在（AI 页依赖它）
  const st = await call('GET', '/stations/' + SID, undefined, token);
  if (st.status !== 200) {
    const made = await call('POST', '/stations/from-cmc', {
      cmc_line_id: 392, station_id: SID, name: 'PA10 装配工位（真实视频验证）', tt: 60,
    }, token);
    check('重建 PA10 工位', made.status === 200 || made.status === 201, `status=${made.status}`);
  } else {
    check('PA10 工位存在', true);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,1000'],
    protocolTimeout: READY_MS + 120000,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));

    // 引导（v3.39 重构）：token 用 evaluateOnNewDocument 在首个文档脚本前注入。
    // 旧写法「goto(WEB) → setItem → goto(?b=x#/target)」有跨文档竞态：doc0 的 React
    // 若已在导航前挂载，会用旧 token 刷新一次，doc1 再刷新一次 → 同一 refresh token
    // 被两个文档实例并发使用 → 服务端重放检测吊销全部会话 → 页面「无故」退回登录页。
    // 单航班只防同一模块实例，防不了跨文档；从结构上消除 doc0 才是正解。
    await page.evaluateOnNewDocument((rt) => {
      localStorage.setItem('ie_refresh_token', rt);
      localStorage.setItem('wb-help-seen', '1');
      localStorage.removeItem('ai-seg-detector'); // 确保默认 motion
    }, login.body.refreshToken);
    await page.goto(`${WEB}/#/ai-segment/${SID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction((rt) => localStorage.getItem('ie_refresh_token') !== rt,
      login.body.refreshToken, { timeout: 30000 });
    await page.waitForSelector('.aip-head', { timeout: 30000 });

    const serverInput = await page.$('input[aria-label="选择服务器上传视频"]');
    const localInput = await page.$('input[aria-label="选择本地视频文件"]');
    check('「从服务器载入」上传入口存在', !!serverInput && !!localInput);

    const waitVideoReady = async () => {
      await page.waitForFunction(() => {
        const v = document.querySelector('.aip-video video');
        return v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
      }, { timeout: READY_MS, polling: 300 });
      return page.evaluate(() => {
        const v = document.querySelector('.aip-video video');
        return { duration: +v.duration.toFixed(2), w: v.videoWidth, h: v.videoHeight };
      });
    };
    const legendText = () => page.$eval('.aip-tl-legend span', (e) => e.textContent.trim());

    /** 上传并等到「新视频真正就绪」：label 退出 is-busy + legend 出现目标文件名。
     *  （早期版本只等 readyState，旧视频仍满足条件 → 抢跑点分析 → 分析中换源 → 无输出） */
    const uploadVia = async (file, namePart) => {
      await serverInput.uploadFile(file);
      await page.waitForFunction(() => {
        const lab = document.querySelector('input[aria-label="选择服务器上传视频"]').closest('label');
        return lab && !lab.className.includes('is-busy');
      }, { timeout: READY_MS, polling: 200 });
      await page.waitForFunction((np) => {
        const lg = document.querySelector('.aip-tl-legend span');
        return lg && lg.textContent.includes(np);
      }, { timeout: READY_MS, polling: 200 }, namePart);
      return waitVideoReady();
    };

    // ── 1. H.264 MP4：免转码直通 ──
    let meta = await uploadVia(path.join(REAL, 'sample60.mp4'), 'sample60.mp4');
    check('H.264 上传后视频就绪（60s 片段）', meta.duration > 55 && meta.duration < 65, JSON.stringify(meta));
    check('视频来源标注为服务器', (await legendText()).includes('服务器'), await legendText());

    // ── 2. HEVC MP4：raw=1 免转码直通（手机拍片的主流格式）──
    meta = await uploadVia(path.join(REAL, 'hevc15.mp4'), 'hevc15.mp4');
    check('HEVC 免转码直通后视频就绪（15s 切片）', meta.duration > 13 && meta.duration < 17, JSON.stringify(meta));
    check('HEVC 标注直通（未经转码）', (await legendText()).includes('直通'), await legendText());

    // ── 3. HEVC 视频跑分析：证明直通链路产出的视频可被抽帧分析 ──
    await page.evaluate(() => {
      [...document.querySelectorAll('.aip-acts button')].find((x) => x.textContent.includes('开始分析')).click();
    });
    await page.waitForFunction(() => document.querySelectorAll('.ais-table tbody tr').length > 0,
      { timeout: ANALYZE_MS, polling: 1000 });
    const candCount = await page.evaluate(() => document.querySelectorAll('.ais-table tbody tr').length);
    check('HEVC 直通视频可分析出候选', candCount >= 1, '候选=' + candCount);
    await page.screenshot({ path: path.join(REAL, 'upload-hevc-result.png') });

    // ── 4. MKV(H.264)：扩展名不在白名单 → 服务端自动转码 ──
    meta = await uploadVia(path.join(REAL, 'mkv5.mkv'), 'mkv5.mkv');
    check('MKV 上传转码后视频就绪（约 6.8s）', meta.duration > 4 && meta.duration < 9, JSON.stringify(meta));
    check('MKV 标注已转码', (await legendText()).includes('已转码'), await legendText());

    // ── 5. 假 .avi：直接转码失败 → 明确错误、页面不白屏 ──
    const fakeAvi = path.join(REAL, 'fake.avi');
    fs.writeFileSync(fakeAvi, '这不是视频文件'.repeat(200));
    await serverInput.uploadFile(fakeAvi);
    await page.waitForFunction(() => /载入失败|转码重试失败/.test(document.body.innerText),
      { timeout: READY_MS, polling: 300 });
    const errAvi = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.aip-stage p, .aip-stage div')].find((x) => /失败/.test(x.textContent || ''));
      return el ? el.textContent.trim().slice(0, 120) : '';
    });
    check('假 .avi 给出明确错误提示', /失败/.test(errAvi), errAvi);
    check('报错后页面仍可用（.aip-head 在）', await page.evaluate(() => !!document.querySelector('.aip-head')));

    // ── 6. 假 .mp4：直通"成功"但播不了 → 自动转码重试 → 报错、不白屏 ──
    const fakeMp4 = path.join(REAL, 'fake.mp4');
    fs.writeFileSync(fakeMp4, '这也不是视频文件'.repeat(200));
    await serverInput.uploadFile(fakeMp4);
    await page.waitForFunction(() => /转码重试失败|无法直接播放|载入失败/.test(document.body.innerText),
      { timeout: READY_MS, polling: 300 });
    const errMp4 = await page.evaluate(() => document.body.innerText.match(/.{0,40}(转码重试失败|无法直接播放|载入失败).{0,60}/));
    check('假 .mp4 触发自动转码重试并报错', !!errMp4, errMp4 ? errMp4[0] : '');
    check('两次失败后页面仍可用', await page.evaluate(() => !!document.querySelector('.aip-head')));

    check('全程无未捕获页面异常', pageErrors.length === 0, pageErrors.join(' | '));

    // 收尾截图 + 清理假文件
    await page.screenshot({ path: path.join(REAL, 'upload-final.png') });
    fs.unlinkSync(fakeAvi); fs.unlinkSync(fakeMp4);
  } finally {
    await browser.close();
  }

  console.log('\n结果: ' + ok + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
