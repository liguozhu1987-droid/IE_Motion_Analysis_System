/* 探测运行中 API 的 generate-manual 端点（QA 临时） */
(async () => {
  const lr = await fetch('http://127.0.0.1:3001/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '123456' }),
  });
  const login = await lr.json();
  if (!login.accessToken) { console.log('LOGIN FAIL', JSON.stringify(login).slice(0, 200)); process.exit(1); }
  console.log('login ok');
  const r = await fetch('http://127.0.0.1:3001/api/stations/L01-ST33/ai-waste/generate-manual', {
    method: 'POST', headers: { authorization: 'Bearer ' + login.accessToken },
  });
  const t = await r.text();
  console.log('generate-manual status:', r.status);
  console.log(t.slice(0, 300));
})().catch((e) => { console.error(e.message); process.exit(1); });
