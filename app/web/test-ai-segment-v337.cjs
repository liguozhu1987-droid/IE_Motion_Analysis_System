/**
 * v3.37 回归：AI 自动分解 · 双检测器
 *
 * 覆盖本次改动的真实行为，不做无断言的空跑：
 *   1. 默认检测方式 = 运动能量（车间戴手套是常态）
 *   2. 空态提示随检测方式切换（用户要知道两种方式的取舍）
 *   3. 选择持久化到 localStorage，重载后仍生效
 *   4. 切换检测方式会清空上一轮结果（两套算法结果不可混用）
 *   5. 运动能量在真实工位片段上的产出质量：覆盖、段长中位、无超长段、手别不单一
 *   6. 手部关键点检测器仍然可选且能跑完（不回归）
 *
 * 用法：node test-ai-segment-v337.cjs
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SID = 'PA10';
const CLIP = path.resolve(__dirname, '..', '..', 'deliverables', 'ai-segment', 'real', 'sample30.mp4');
const SHOT = path.resolve(__dirname, '..', '..', 'deliverables', 'ai-segment', 'real');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(CLIP)) throw new Error('缺测试片段: ' + CLIP);
  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,1000'],
    protocolTimeout: 1200000,
  });
  const errors = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));

    let bootSeq = 0;
    /* v3.39 确定性引导（彻底替换旧的双 goto + reload 模式）：
       旧模式「goto(WEB)→setItem→goto(?b=N#/target)→reload」有跨文档竞态——
       doc0 的 React 若在导航前已挂载，会用旧 token 刷新一次，doc1 再刷新一次，
       同一 refresh token 被两个文档实例并发使用 → 服务端重放检测吊销全部会话
       → 页面「无故」退回登录页（单航班只能防同一模块实例，防不了跨文档）。
       新模式：token 在首个文档任何脚本之前注入（evaluateOnNewDocument），
       且仅在 localStorage 无 token 时才注入——重引导时沿用已轮换的当前值，
       绝不重复注入原始 token（那会触发重放检测）。?b=N 保证完整文档加载。 */
    const boot = async (fresh) => {
      await page.evaluateOnNewDocument((rt, clr) => {
        if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
        localStorage.setItem('wb-help-seen', '1');
        /* 清理只做一次：evaluateOnNewDocument 的闭包参数对每次文档创建都生效，
           直接信任 clr 会让 reload 也重复 removeItem（把「跨刷新保留」断言擦掉=假失败）。
           用 sessionStorage 哨兵保证仅首个文档清理。 */
        if (clr && !sessionStorage.getItem('ai-seg-boot-cleared')) {
          localStorage.removeItem('ai-seg-detector');
          sessionStorage.setItem('ai-seg-boot-cleared', '1');
        }
      }, login.refreshToken, fresh);
      await page.goto(`${WEB}/?b=${(bootSeq += 1)}#/ai-segment/${SID}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('.aip-head', { timeout: 30000 });
    };

    // ── 1. 默认检测方式 ──
    await boot(true);
    const def = await page.$eval('.aip-sel', (s) => s.value);
    ok('默认检测方式 = motion', def === 'motion', def);

    // ── 2. 空态提示随检测方式变化 ──
    const hintMotion = await page.$eval('.ais-empty', (e) => e.textContent || '');
    ok('空态提示说明运动能量的取舍', /运动能量/.test(hintMotion), hintMotion.slice(0, 80));

    await page.select('.aip-sel', 'hand');
    await sleep(300);
    const hintHand = await page.$eval('.ais-empty', (e) => e.textContent || '');
    ok('切到手部关键点后提示同步变化', /手部关键点/.test(hintHand) && hintHand !== hintMotion, hintHand.slice(0, 80));

    // ── 3. 选择持久化 ──
    await page.reload({ waitUntil: 'networkidle2' });
    await page.waitForSelector('.aip-sel', { timeout: 30000 });
    const afterReload = await page.$eval('.aip-sel', (s) => s.value);
    ok('检测方式选择跨刷新保留', afterReload === 'hand', afterReload);

    // 回到 motion
    await page.select('.aip-sel', 'motion');
    await sleep(300);

    // ── 4~5. 运动能量真实分析 ──
    const input = await page.$('input[type=file]');
    await input.uploadFile(CLIP);
    await page.waitForFunction(() => {
      const v = document.querySelector('.aip-video video');
      return v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
    }, { timeout: 60000 });
    const dur = await page.evaluate(() => document.querySelector('.aip-video video').duration);

    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('.aip-acts button')].find((x) => x.textContent.includes('开始分析'));
      return b && !b.disabled;
    }, { timeout: 30000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('.aip-acts button')].find((x) => x.textContent.includes('开始分析')).click();
    });

    const t0 = Date.now();
    let done = false;
    while (Date.now() - t0 < 600000) {
      const st = await page.evaluate(() => ({
        running: [...document.querySelectorAll('.aip-acts button')].some((x) => x.textContent.includes('停止分析')),
        err: (document.querySelector('.aip-error') || {}).textContent || '',
      }));
      if (st.err) throw new Error('分析报错: ' + st.err);
      if (!st.running) { done = true; break; }
      await sleep(1000);
    }
    ok('运动能量分析正常跑完', done, '超时');

    const rows = await page.evaluate(() => [...document.querySelectorAll('.ais-table tbody tr')].map((tr) => {
      const td = tr.querySelectorAll('td');
      // v3.38b 修：tier 必须取「· 」后的档位词。
      // 曾用 /低/.test(conf) 全文匹配，把分类依据「长时(4.4s)低幅」的「低」
      // 误判成 low（实测 11 条全 0.90·高，统计成 高6/低5，假失败）。
      const conf = td[5].textContent.trim();
      const m = conf.match(/·\s*([高中低])/);
      return {
        hand: tr.querySelector('select').value,
        dur: parseFloat(td[4].textContent),
        conf,
        tier: m ? (m[1] === '低' ? 'low' : m[1] === '中' ? 'mid' : 'high') : '?',
        include: tr.querySelector('input[type=checkbox]').checked,
      };
    }));
    // 档位解析兜底：不允许出现 '?'（说明列结构变了，测试必须显式失败而非静默通过）
    ok('置信列档位可解析（v3.38b 修 /低/ 误匹配「低幅」）', rows.every((r) => r.tier !== '?'), JSON.stringify(rows.map((r) => r.tier).join(',')));
    // v3.38b：置信度与类型解耦——段置信由边界/时长/能量决定，类型只做建议不降档。
    // 合并边界（微停顿回填）必须给中档 + 「建议核对」，否则 tier 失去信息量。
    const microMerged = rows.filter((r) => /微停顿合并/.test(r.conf));
    if (microMerged.length > 0) {
      ok('合并边界标中档并提示核对（v3.38b 置信分层）', microMerged.every((r) => r.tier === 'mid' && /建议核对/.test(r.conf)),
        `${microMerged.length} 条，档位 ${microMerged.map((r) => r.tier).join(',')}`);
    } else {
      ok('合并边界标中档并提示核对（本片段无合并边界，跳过）', true, '0 条');
    }

    ok('候选条数合理（30s 片段 ≥ 8 条）', rows.length >= 8, rows.length);
    // v3.38 新增：类型不再是清一色「其他」，描述不再是「AI 候选N」
    const typeCells = await page.evaluate(() => [...document.querySelectorAll('.ais-table tbody tr')].map((tr) => {
      const td = tr.querySelectorAll('td');
      const inp = tr.querySelector('input.aip-inp');
      const desc = tr.querySelector('input.aip-inp.wide');
      return { type: inp ? inp.value : '', desc: desc ? desc.value : '' };
    }));
    const nonOther = typeCells.filter((r) => r.type && r.type !== '其他').length;
    ok('类型建议非清一色「其他」（v3.38 运动学分类生效）', nonOther >= rows.length * 0.5, `${nonOther}/${rows.length}`);
    const noLegacyDesc = typeCells.filter((r) => !/^AI 候选/.test(r.desc)).length;
    ok('描述为标准库骨架（非「AI 候选N」）', noLegacyDesc === rows.length, `${noLegacyDesc}/${rows.length}`);
    const inclDur = rows.filter((r) => r.include).reduce((s, r) => s + r.dur, 0);
    const cover = +(inclDur / dur * 100).toFixed(1);
    ok('覆盖率 ≥ 60%（对比 MediaPipe 首测 20.6%）', cover >= 60, cover + '%');
    const durs = rows.map((r) => r.dur).sort((a, b) => a - b);
    const med = durs[Math.floor(durs.length / 2)];
    ok('段时长中位 ≥ 1.0s（不再碎成 0.4s）', med >= 1.0, med + 's');
    ok('无 >6s 的超长段', durs[durs.length - 1] <= 6.1, durs[durs.length - 1] + 's');
    const hands = new Set(rows.map((r) => r.hand));
    ok('手别不单一（至少两种）', hands.size >= 2, [...hands].join(','));
    ok('多数候选默认勾选（可直接批量确认）', rows.filter((r) => r.include).length / rows.length >= 0.6,
      `${rows.filter((r) => r.include).length}/${rows.length}`);

    // ── 4. 切换检测方式清空结果 ──
    await page.select('.aip-sel', 'hand');
    await sleep(400);
    const cleared = await page.evaluate(() => ({
      rows: document.querySelectorAll('.ais-table tbody tr').length,
      empty: !!document.querySelector('.ais-empty'),
    }));
    ok('切换检测方式后旧结果被清空', cleared.rows === 0 && cleared.empty, JSON.stringify(cleared));

    // 切回 motion
    await page.select('.aip-sel', 'motion');
    await sleep(300);

    // ── 6. 手部关键点检测器仍可用（不回归） ──
    await page.select('.aip-sel', 'hand');
    await sleep(300);
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('.aip-acts button')].find((x) => x.textContent.includes('开始分析'));
      return b && !b.disabled;
    }, { timeout: 30000 });
    await page.evaluate(() => {
      [...document.querySelectorAll('.aip-acts button')].find((x) => x.textContent.includes('开始分析')).click();
    });
    const t1 = Date.now();
    let done2 = false;
    while (Date.now() - t1 < 600000) {
      const st = await page.evaluate(() => ({
        running: [...document.querySelectorAll('.aip-acts button')].some((x) => x.textContent.includes('停止分析')),
        err: (document.querySelector('.aip-error') || {}).textContent || '',
      }));
      if (st.err) throw new Error('手部关键点分析报错: ' + st.err);
      if (!st.running) { done2 = true; break; }
      await sleep(1000);
    }
    ok('手部关键点检测器仍可跑完（无回归）', done2, '超时');

    // 回到默认，避免污染后续手工验证
    await page.select('.aip-sel', 'motion');
    await sleep(300);
    const head = await page.$('.aip-head');
    if (head) await head.screenshot({ path: path.join(SHOT, 'v337-head.png') });
    await page.screenshot({ path: path.join(SHOT, 'v337-final.png') });

    ok('全程无未捕获页面异常', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('TEST FAIL', e.message); process.exit(1); });
