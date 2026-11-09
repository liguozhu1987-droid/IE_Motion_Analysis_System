process.env.DB_TYPE = 'mssql';
require(process.cwd()+'/node_modules/dotenv').config();
require('reflect-metadata');
const { createServer } = require('node:http');
const { NestFactory } = require(process.cwd()+'/node_modules/@nestjs/core');
const { AppModule } = require('../dist/src/app.module.js');
const { AllExceptionsFilter } = require('../dist/src/core/all-exceptions.filter.js');

async function api(base, method, path, opts = {}) {
  const headers = { 'content-type': 'application/json' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, data: json, text };
}

(async () => {
  const mock = createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      console.log('MOCK CALLED, body keys:', Object.keys(JSON.parse(b || '{}')));
      const suggestions = [
        { element_seqs: [1], waste_type: '持住', method: 'E', measure: '治具夹持替代手持扶住壳体', eliminate_basis: 'SOP规定双手装配无需人工持住', verif: 3 },
      ];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(suggestions) } }], usage: { total_tokens: 100 } }));
    });
  });
  await new Promise(r => mock.listen(19098, '127.0.0.1', r));
  process.env.AI_SUGGEST_ENABLED = 'true';
  process.env.AI_LLM_BASE_URL = 'http://127.0.0.1:19098/v1';
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const admin = await api(base, 'POST', '/api/auth/login', { body: { username: 'admin', password: '123456' } });
  const stId = 'L01-ST77';
  // 建工位+要素
  await api(base, 'POST', '/api/stations', { token: admin.data.accessToken, body: { station_id: stId, line_id: 'L01', name: 'repro', tt: 40 } });
  await api(base, 'POST', `/api/stations/${stId}/elements/submit`, { token: admin.data.accessToken, body: { cycle_count: 15, cv: 0.05, elements: [
    { seq: 1, start_ms: 0, dur_s: 3.2, hand: 'R', type: '持住', desc: '手持住扶壳体', va_class: 'NVA' },
    { seq: 2, start_ms: 3200, dur_s: 2.8, hand: 'R', type: '移物', desc: '取前壳', va_class: 'VA' },
  ] } });
  const gen = await api(base, 'POST', `/api/stations/${stId}/ai-suggestions/generate`, { token: admin.data.accessToken });
  console.log('GEN STATUS:', gen.status);
  console.log('GEN BODY:', JSON.stringify(gen.data).slice(0, 800));
  await app.close();
  mock.close();
  process.exit(0);
})().catch(e => { console.error('REPRO ERR:', e); process.exit(1); });
