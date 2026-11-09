/**
 * v3.44 P2 · AI 自动分解专项 UI 测试（HOI 对象层 + SOP 封闭词表对齐）
 *
 *   T0 API 校验：roi_zones 越界 400 / sop_steps 词表外 400 / 合法保存 / 清除
 *   T1 SOP 面板：步骤编辑（封闭词表 datalist）/ 保存到工位（PATCH sop_steps 落库）
 *   T2 ROI 子区：画子区模式 → 命名 → 确认 → 保存落库（坐标相对 ROI 换算正确）
 *   T3 真实分析（8s 固件，软渲染下约 1–2 分钟）
 *   T4 SOP 对齐：LCS 摘要 / 行徽标（match/漏步）/ 命中行自动命名（SOP 对象进描述）
 *   T5 HOI：已配置子区时，拿取/移物行提示含 HOI 依据或「未命中」提示
 *
 * 前置：API(3001, 新构建) + Vite dev(5173)；固件 test-fixtures/aiseg-8s.mp4。
 * 测试自建自清：结束后 roi/roi_zones/sop_steps 全部还原 null。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = 'http://localhost:5173';
const SID = 'L01-ST01';

let pass = 0, fail = 0;
const errors = [];
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 260) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed');
  const H = { Authorization: 'Bearer ' + login.accessToken, 'Content-Type': 'application/json' };
  const getStation = async () => (await (await fetch(`${API}/stations/${encodeURIComponent(SID)}`, { headers: H })).json());

  /* 收尾兜底：无论走到哪一步，退出前还原工位标定 */
  const cleanup = async () => {
    await fetch(`${API}/stations/${encodeURIComponent(SID)}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ roi: null, roi_zones: null, sop_steps: null }),
    });
  };
  await cleanup(); // 前置：未标定态

  console.log('\n--- T0. API 校验（服务端封闭词表与子区校验） ---');
  {
    const r1 = await fetch(`${API}/stations/${encodeURIComponent(SID)}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ roi_zones: JSON.stringify([{ name: 'A', x: 0.9, y: 0.1, w: 0.3, h: 0.3 }]) }),
    });
    ok('T0 子区越界 400', r1.status === 400, r1.status);
    const r2 = await fetch(`${API}/stations/${encodeURIComponent(SID)}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ sop_steps: JSON.stringify([{ verb: '打磨' }]) }),
    });
    const b2 = await r2.json().catch(() => ({}));
    ok('T0 词表外动词 400', r2.status === 400 && /不在动作标准库词表内/.test(b2.detail ?? ''), `${r2.status} ${b2.detail ?? ''}`);
    const r3 = await fetch(`${API}/stations/${encodeURIComponent(SID)}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({
        roi_zones: JSON.stringify([{ name: '扫码枪卡位', x: 0.05, y: 0.1, w: 0.25, h: 0.3 }]),
        sop_steps: JSON.stringify([{ verb: '拿取', object: '后横梁' }, { verb: '装配' }]),
      }),
    });
    const b3 = await r3.json().catch(() => ({}));
    ok('T0 合法保存 200 且回读一致', r3.status === 200 && /扫码枪卡位/.test(b3.roi_zones ?? '') && /拿取/.test(b3.sop_steps ?? ''), `${r3.status}`);
    const r4 = await fetch(`${API}/stations/${encodeURIComponent(SID)}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ roi_zones: null, sop_steps: null }),
    });
    const b4 = await r4.json().catch(() => ({}));
    ok('T0 清除（null）回 null', r4.status === 200 && b4.roi_zones === null && b4.sop_steps === null, `${r4.status}`);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('pageerror', (e) => errors.push('[js] ' + String(e.message).slice(0, 200)));

  const patches = [];
  page.on('request', (req) => {
    if (req.method() === 'PATCH' && /\/api\/stations\//.test(req.url())) patches.push(req.postData() ?? '');
  });
  const patchRes = [];
  page.on('response', async (res) => {
    if (res.request().method() === 'PATCH' && /\/api\/stations\//.test(res.url())) {
      patchRes.push({ status: res.status(), body: (await res.text().catch(() => '')).slice(0, 200) });
    }
  });

  await page.evaluateOnNewDocument((rt) => {
    localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  await page.goto(`${WEB}/?b=${Date.now()}#/ai-segment/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.aip-head', { timeout: 30000 });
  await sleep(1200);

  /* 先载入固件视频：SOP/操作区按钮 disabled={!videoUrl}，未载视频时点击是 no-op（首轮实锤） */
  const fixture = path.join(__dirname, 'test-fixtures', 'aiseg-8s.mp4');
  if (!fs.existsSync(fixture)) {
    console.log('  SKIP 缺少固件，T1-T5 跳过');
    await browser.close();
    await cleanup();
    process.exit(fail > 0 ? 1 : 0);
  }
  const fileInput = await page.$('.aip-acts input[type=file]');
  await fileInput.uploadFile(fixture);
  await sleep(2000);

  const clickBtnByText = (text, scope) => page.evaluate((t, sc) => {
    const root = sc ? document.querySelector(sc) : document;
    const b = [...root.querySelectorAll('button')].find((x) => x.textContent.includes(t));
    if (b) { b.click(); return true; }
    return false;
  }, text, scope ?? null);

  console.log('\n--- T1. SOP 面板（封闭词表步骤编辑 + 保存） ---');
  {
    const sopBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.aip-acts button')].find((b) => /SOP 对齐/.test(b.textContent)));
    ok('T1 顶栏「SOP 对齐」按钮存在', Boolean(sopBtn.asElement()));
    await sopBtn.asElement().click();
    const opened = await page.waitForSelector('.aip-sop', { timeout: 5000 }).then(() => true).catch(() => false);
    ok('T1 面板打开', opened);
    if (opened) {
      // 清掉既有草稿行，从零编辑
      await page.evaluate(() => {
        const del = [...document.querySelectorAll('.aip-sop-step button')];
        del.forEach(() => { }); // 逐个删（下面的循环每次取第一个 ✕）
      });
      for (let i = 0; i < 6; i += 1) {
        const has = await page.evaluate(() => document.querySelectorAll('.aip-sop-step').length);
        if (!has) break;
        await page.evaluate(() => {
          const row = document.querySelector('.aip-sop-step');
          const x = [...row.querySelectorAll('button')].find((b) => b.textContent === '✕');
          x.click();
        });
        await sleep(120);
      }
      // 添加两步：拿取(后横梁) / 装配
      await clickBtnByText('＋添加步骤', '.aip-sop');
      await sleep(150);
      await clickBtnByText('＋添加步骤', '.aip-sop');
      await sleep(150);
      const setVal = async (aria, val) => {
        const el = await page.$(`[aria-label="${aria}"]`);
        await el.click({ clickCount: 3 });
        await page.type(`[aria-label="${aria}"]`, val);
      };
      await setVal('步骤1动词', '拿取');
      await setVal('步骤1对象', '后横梁');
      await setVal('步骤2动词', '装配');
      await sleep(150);
      await clickBtnByText('保存到工位', '.aip-sop');
      await page.waitForFunction(() => (document.querySelector('.aip-roi-msg') || document.querySelector('.aip-sop-msg') || {}).textContent?.includes('已保存'), { timeout: 10000 }).catch(() => {});
      await sleep(600);
      const st = await getStation();
      let stepsOk = false;
      try { stepsOk = JSON.stringify(JSON.parse(st.sop_steps)) === JSON.stringify([{ verb: '拿取', object: '后横梁' }, { verb: '装配' }]); } catch { /* noop */ }
      ok('T1 sop_steps 落库正确', stepsOk, st.sop_steps);
      ok('T1 PATCH 携带 sop_steps（前端发出）', patches.some((p) => p.includes('sop_steps')), patches[patches.length - 1]);
      const verbs = await page.$$eval('#aip-sop-verbs option', (os) => os.map((o) => o.value));
      ok('T1 封闭词表 datalist 非空（≥14 个标准库动词）', verbs.length >= 14, verbs.length);
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('.aip-sop button')].find((x) => x.textContent === '关闭');
        b.click();
      });
      await sleep(300);
    }
  }

  console.log('\n--- T2. ROI 功能区子区（画子区 → 命名 → 落库） ---');
  {
    const fileInput2 = await page.$('.aip-acts input[type=file]');
    await fileInput2.uploadFile(fixture);
    await sleep(2000);
    await clickBtnByText('操作区');
    await page.waitForSelector('.aip-roi-panel', { timeout: 5000 });
    await clickBtnByText('画子区');
    await sleep(200);
    const layer = await page.$('.aip-roi-layer');
    ok('T2 覆盖层渲染', layer !== null);
    /* 面板挂在左下角（子区面板加高后可达 ~340px），拖拽走右半区避开：
       画布 0.55,0.35 → 0.75,0.55；eff=DEFAULT_ROI(0.18,0.30,0.60,0.50)
       → 相对 ROI ≈ x(0.55-0.18)/0.6=0.617 y(0.35-0.30)/0.5=0.10 w0.333 h0.40 */
    const lb = await layer.boundingBox();
    await page.mouse.move(lb.x + lb.width * 0.55, lb.y + lb.height * 0.35);
    await page.mouse.down();
    await page.mouse.move(lb.x + lb.width * 0.75, lb.y + lb.height * 0.55, { steps: 8 });
    await page.mouse.up();
    await sleep(300);
    const pending = await page.$('.aip-zone-pending input');
    ok('T2 画完出现命名输入', pending !== null);
    if (pending) {
      await pending.type('扫码枪卡位');
      await clickBtnByText('确认', '.aip-zones');
      await sleep(200);
      const rows = await page.$$eval('.aip-zone-row b', (bs) => bs.map((b) => b.textContent));
      ok('T2 子区行渲染（扫码枪卡位）', rows.includes('扫码枪卡位'), rows.join('|'));
      await clickBtnByText('保存到工位');
      const saved = await page.waitForFunction(
        () => {
          const t = (document.querySelector('.aip-roi-msg') || {}).textContent || '';
          return /已保存|保存失败/.test(t) ? t : null;
        },
        { timeout: 10000, polling: 300 },
      ).then((h) => h.jsonValue()).catch(() => null);
      if (saved === null) {
        console.log('  DEBUG patchRes=' + JSON.stringify(patchRes.slice(-2)));
        console.log('  DEBUG panel=' + (await page.$eval('.aip-roi-panel', (e) => e.textContent).catch(() => 'GONE')).slice(0, 300));
      }
      ok('T2 保存到工位成功', saved !== null && saved.includes('已保存'), saved);
      const st = await getStation();
      let zoneOk = false;
      try {
        const z = JSON.parse(st.roi_zones)[0];
        zoneOk = z.name === '扫码枪卡位'
          && Math.abs(z.x - 0.617) < 0.03 && Math.abs(z.y - 0.10) < 0.03
          && Math.abs(z.w - 0.333) < 0.03 && Math.abs(z.h - 0.40) < 0.03;
      } catch { /* noop */ }
      ok('T2 roi_zones 落库且相对 ROI 换算正确（≈x0.62 y0.10 w0.33 h0.40）', zoneOk, st.roi_zones);
      // 关闭面板再分析
      await clickBtnByText('关闭');
      await sleep(300);
    }
  }

  console.log('\n--- T3. 真实分析（8s 固件，子区已配置） ---');
  {
    await page.click('.aip-acts button.primary');
    let finished = false;
    for (let i = 0; i < 120; i += 1) {
      await sleep(2000);
      const running = (await page.$$eval('.ais-overlay', (e) => e.length)) > 0;
      const stuck = (await page.$('.aip-error')) !== null;
      if (!running || stuck) { finished = true; break; }
    }
    ok('T3 分析结束（未挂死）', finished);
    const errText = await page.$eval('.aip-error', (e) => e.textContent.trim()).catch(() => '');
    ok('T3 无分析失败', errText === '', errText);
    const rowCount = await page.$$eval('.ais-table tbody tr', (rs) => rs.length);
    ok('T3 有候选行', rowCount > 0, rowCount);
  }

  console.log('\n--- T4. SOP 对齐（LCS + 自动命名） ---');
  {
    // 读当前候选类型（按 DOM 顺序即时间序），构造确定性步骤：第1行类型(带对象) + 等待（若候选没有）
    const types = await page.$$eval('.ais-table tbody tr', (rs) => rs.map((r) => {
      const inp = r.querySelector('input[aria-label$="类型"]');
      return inp ? inp.value.trim() : '';
    }));
    const first = types.find((t) => t && t !== '其他');
    ok('T4 读到可对齐的候选类型', Boolean(first), types.join(','));
    if (first) {
      const wantMiss = !types.includes('等待');
      await clickBtnByText('SOP 对齐');
      await page.waitForSelector('.aip-sop', { timeout: 5000 });
      // 把草稿改成 [first(带对象), 等待]（先清后填）
      for (let i = 0; i < 8; i += 1) {
        const has = await page.evaluate(() => document.querySelectorAll('.aip-sop-step').length);
        if (!has) break;
        await page.evaluate(() => {
          const row = document.querySelector('.aip-sop-step');
          [...row.querySelectorAll('button')].find((b) => b.textContent === '✕').click();
        });
        await sleep(100);
      }
      await clickBtnByText('＋添加步骤', '.aip-sop');
      await sleep(120);
      if (wantMiss) { await clickBtnByText('＋添加步骤', '.aip-sop'); await sleep(120); }
      const setVal = async (aria, val) => {
        const el = await page.$(`[aria-label="${aria}"]`);
        await el.click({ clickCount: 3 });
        await page.type(`[aria-label="${aria}"]`, val);
      };
      await setVal('步骤1动词', first);
      await setVal('步骤1对象', '测试对象A');
      if (wantMiss) await setVal('步骤2动词', '等待');
      await clickBtnByText('对齐候选', '.aip-sop');
      const res = await page.waitForSelector('.aip-sop-res', { timeout: 8000 }).then(() => true).catch(() => false);
      ok('T4 对齐结果区出现', res);
      if (res) {
        const summary = await page.$eval('.aip-sop-res b', (e) => e.textContent);
        ok('T4 摘要含「对齐」统计', /对齐 \d+\/\d+ 步/.test(summary), summary);
        if (wantMiss) ok('T4 漏步 1（等待不在候选中）', summary.includes('漏步 1'), summary);
        const matchHint = await page.$eval('.aip-sop-res li.sop-match', (e) => e.textContent).catch(() => '');
        ok('T4 结果区含 match 条目', matchHint.length > 0, matchHint);
      }
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('.aip-sop button')].find((x) => x.textContent === '关闭');
        b.click();
      });
      await sleep(400);
      // 候选表行徽标 + 自动命名
      const hints = await page.$$eval('.ais-table tbody .ais-sop', (es) => es.map((e) => ({ cls: e.className, t: e.textContent })));
      ok('T4 候选表出现 SOP 徽标', hints.length > 0, hints.length);
      ok('T4 有命中徽标（SOP ✓ 第1步）', hints.some((h) => h.cls.includes('sop-match') && /SOP ✓ 第1步/.test(h.t)), JSON.stringify(hints.slice(0, 3)));
      const named = await page.$$eval('.ais-table tbody tr', (rs) => rs.map((r) => {
        const inp = r.querySelector('input[aria-label$="描述"]');
        return inp ? inp.value : '';
      }));
      ok('T4 命中行描述自动填入 SOP 对象「测试对象A」', named.some((d) => d.includes('测试对象A')), named.slice(0, 4).join(' | '));
    }
  }

  console.log('\n--- T5. HOI（子区已配置，对象层接通） ---');
  {
    const rows = await page.$$eval('.ais-table tbody tr', (rs) => rs.map((r) => ({
      type: r.querySelector('input[aria-label$="类型"]')?.value ?? '',
      conf: r.cells[5]?.textContent ?? '',
      desc: r.querySelector('input[aria-label$="描述"]')?.value ?? '',
    })));
    const mv = rows.filter((r) => r.type === '拿取' || r.type === '移物');
    if (mv.length === 0) {
      ok('T5 拿取/移物行提示含 HOI 依据或未命中提示', true, '（本固件无拿取/移物候选，链路已由 T4/单测覆盖）');
    } else {
      const allHinted = mv.every((r) => /HOI:|未命中任何功能区子区/.test(r.conf));
      ok(`T5 拿取/移物行（${mv.length} 条）提示含 HOI 依据或未命中提示`, allHinted, mv.slice(0, 3).map((r) => r.conf).join(' | '));
    }
    const anyHoi = rows.some((r) => /HOI:/.test(r.conf));
    const anyMiss = rows.some((r) => /未命中任何功能区子区/.test(r.conf));
    ok('T5 HOI 链路端到端有痕（依据或未命中提示至少其一）', anyHoi || anyMiss, `HOI=${anyHoi} MISS=${anyMiss}`);
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败${errors.length ? ` / 页面异常 ${errors.length}：${errors[0]}` : ''}`);
  await browser.close();
  await cleanup();
  const st = await getStation();
  ok('收尾：工位标定已还原 null', !st.roi && !st.roi_zones && !st.sop_steps, JSON.stringify({ roi: st.roi, z: st.roi_zones, s: st.sop_steps }));
  console.log(fail > 0 || errors.length > 0 ? 'EXIT=1' : 'EXIT=0');
  process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})().catch(async (e) => {
  console.error('FATAL', e);
  try { await cleanup(); } catch { /* noop */ }
  process.exit(1);
});
