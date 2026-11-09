/* 400 探针：新代码确认（generate-manual 应 400 而非 404）+ ai-suggest 根因取证 */
(async () => {
  const lr = await fetch('http://127.0.0.1:3001/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  const auth = { authorization: 'Bearer ' + login.accessToken };
  const r = await fetch('http://127.0.0.1:3001/api/stations/PA10/ai-waste/generate-manual', {
    method: 'POST', headers: auth,
  });
  const t = await r.text();
  console.log('[probe] generate-manual on PA10:', r.status, t.slice(0, 160));
})().catch((e) => { console.error(e.message); process.exit(1); });
