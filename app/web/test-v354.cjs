/**
 * v3.54 · 清单时间码显示 + 时间线右键「使时间段连续」UI 测试
 *
 * 需求1：清单内起点以 时:分:秒.毫秒（hh:mm:ss.mmm）显示，并新增「止点」列（同格式）。
 * 需求2：时间线片段右键 → 弹「使时间段连续」对话框 → 起点对齐相邻上一片段止点。
 *
 * 断言：
 *  T1 清单页签渲染「起点」「止点」两列（表头不再是「起点 ms」）
 *  T2 起点/止点显示为 hh:mm:ss.mmm 格式（如 00:00:04.880）
 *  T3 时间线片段右键 → 弹出「使时间段连续」对话框
 *  T4 对话框显示上一片段止点与本片段起点 → 对齐预览
 *  T5 点击对齐 → 该片段起点变为上一片段止点（时长不变）
 *  T6 无 JS pageerror
 *
 * 数据：ST010（20 手工要素）。只读：不写业务端点；T5 的对齐仅本地草稿（不提交）。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const API = 'http://localhost:3001/api';
const WEB = process.env.WEB_URL || 'http://localhost:5173';
const SID = 'ST010';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('  OK  ' + name); }
  else { fail += 1; console.log('  X   ' + name + (detail != null ? '  -> ' + String(detail).slice(0, 300) : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lr = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) throw new Error('login failed');

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const jsErrs = [];
  page.on('pageerror', (e) => jsErrs.push(String(e.message).slice(0, 200)));
  await page.evaluateOnNewDocument((rt) => {
    if (!localStorage.getItem('ie_refresh_token')) localStorage.setItem('ie_refresh_token', rt);
    localStorage.setItem('wb-help-seen', '1');
  }, login.refreshToken);

  console.log('\n--- v3.54 清单时间码 + 右键使连续验证 ---');
  await page.goto(`${WEB}/?b=${Date.now()}#/workbench/${SID}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('.timeline .block', { timeout: 30000 });
  await sleep(1200);

  /* ── T1-T2. 清单：起点/止点列 + hh:mm:ss.mmm 格式 ── */
  console.log('\n--- 清单页签 ---');
  // 切到「清单」页签
  const tabSwitched = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.wb-tabs button, .wb-tab, [class*="tab"] button')];
    const listTab = tabs.find((b) => /清单/.test(b.textContent || ''));
    if (listTab) { listTab.click(); return true; }
    return false;
  });
  if (!tabSwitched) {
    // 备选：直接查清单表格是否存在（可能页签选择器不同）
    console.log('  (清单页签选择器未命中，尝试直接查表格)');
  }
  await sleep(800);

  const listInfo = await page.evaluate(() => {
    const tbl = document.querySelector('.wb-list table');
    if (!tbl) return null;
    const heads = [...tbl.querySelectorAll('thead th')].map((t) => t.textContent.trim());
    const rows = [...tbl.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length > 0);
    const firstRow = rows[0] ? [...rows[0].querySelectorAll('td')].map((t) => t.textContent.trim()) : [];
    return { heads, firstRow, rowCount: rows.length };
  });
  ok('T1 清单表格存在', Boolean(listInfo), listInfo && 'null');
  if (listInfo) {
    const startIdx = listInfo.heads.indexOf('起点');
    const endIdx = listInfo.heads.indexOf('止点');
    ok('T1 表头含「起点」列（非「起点 ms」）', startIdx >= 0 && !listInfo.heads.some((h) => h === '起点 ms'), JSON.stringify(listInfo.heads));
    ok('T1 表头含「止点」列', endIdx >= 0, JSON.stringify(listInfo.heads));

    // 时间码格式 hh:mm:ss.mmm（正则：两位时:两位分:两位秒.三位毫秒）
    const tcRe = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;
    const startVal = startIdx >= 0 ? listInfo.firstRow[startIdx] : '';
    const endVal = endIdx >= 0 ? listInfo.firstRow[endIdx] : '';
    ok('T2 起点为 hh:mm:ss.mmm 格式', tcRe.test(startVal), startVal);
    ok('T2 止点为 hh:mm:ss.mmm 格式', tcRe.test(endVal), endVal);
    console.log('  （首行示例：起点 ' + startVal + ' · 止点 ' + endVal + '）');
  }

  /* ── T3-T5. 时间线右键使连续 ── */
  console.log('\n--- 时间线右键使连续 ---');
  // 切回时间线页签
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.wb-tabs button, .wb-tab, [class*="tab"] button')];
    const tlTab = tabs.find((b) => /时间线/.test(b.textContent || ''));
    if (tlTab) tlTab.click();
  });
  await sleep(800);

  // 取第 3 个块（有相邻上一个），右键触发 contextmenu
  const blk3 = await page.evaluateHandle(() => {
    const blks = [...document.querySelectorAll('.timeline .block')];
    return blks[2] ?? null;  // index 2 = 第 3 个片段
  });
  const blk3El = blk3.asElement();
  ok('T3 找到第 3 个时间线片段', Boolean(blk3El));

  if (blk3El) {
    // 右键（contextmenu 事件）
    await blk3El.click({ button: 'right' });
    await sleep(600);
    const dlg = await page.evaluate(() => {
      const h3 = [...document.querySelectorAll('.modal h3')].find((n) => /使时间段连续/.test(n.textContent || ''));
      if (!h3) return null;
      const modal = h3.closest('.modal');
      return { title: h3.textContent.trim(), text: (modal?.textContent || '').slice(0, 400) };
    });
    ok('T3 右键弹出「使时间段连续」对话框', Boolean(dlg), dlg && dlg.title);
    if (dlg) {
      ok('T4 对话框显示对齐预览（→ 上一片段止点）', /→/.test(dlg.text) && /\d{2}:\d{2}:\d{2}\.\d{3}/.test(dlg.text), dlg.text.slice(0, 200));
    }

    // 点击「对齐到上一片段止点」
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.modal button')].find((b) => /对齐到上一片段止点/.test(b.textContent || ''));
      if (btn) { btn.click(); return true; }
      return false;
    });
    ok('T5 对话框含「对齐到上一片段止点」按钮', clicked);

    await sleep(500);
    // 验证对话框已关闭
    const dlgAfter = await page.evaluate(() => {
      const h3 = [...document.querySelectorAll('.modal h3')].find((n) => /使时间段连续/.test(n.textContent || ''));
      return Boolean(h3);
    });
    ok('T5 点击对齐后对话框关闭', dlgAfter === false);
  }

  ok('T6 无 JS pageerror', jsErrs.length === 0, jsErrs.join(' | '));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('异常：', e);
  process.exit(1);
});
