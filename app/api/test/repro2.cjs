process.env.DB_TYPE = 'mssql';
require('dotenv').config();
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
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
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(0);
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  const admin = await api(base, 'POST', '/api/auth/login', { body: { username: 'admin', password: '123456' } });
  const stId = 'L01-ST78';
  const created = await api(base, 'POST', '/api/stations', { token: admin.data.accessToken, body: { station_id: stId, line_id: 'L01', name: 'repro2', tt: 40 } });
  console.log('CREATE:', created.status, JSON.stringify(created.data).slice(0, 200));
  const submit = await api(base, 'POST', `/api/stations/${stId}/elements/submit`, { token: admin.data.accessToken, body: { cycle_count: 15, cv: 0.05, elements: [
    { seq: 1, start_ms: 0, dur_s: 3.2, hand: 'R', type: '持住', desc: '手持住扶壳体', va_class: 'NVA' },
    { seq: 2, start_ms: 3200, dur_s: 2.8, hand: 'R', type: '移物', desc: '取前壳', va_class: 'VA' },
  ] } });
  console.log('SUBMIT:', submit.status, JSON.stringify(submit.data).slice(0, 400));
  await app.close(); process.exit(0);
})().catch(e => { console.error('ERR:', e); process.exit(1); });
