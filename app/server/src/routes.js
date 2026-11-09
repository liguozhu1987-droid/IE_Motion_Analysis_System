import { Router } from './http/router.js';
import { BadRequestError } from './errors.js';
import { getDb } from './db/index.js';
import { ruleSnapshot } from './rules/rules.js';
import * as stations from './features/stations/service.js';
import * as elements from './features/elements/service.js';
import { validateSubmission } from './features/elements/validation.js';
import { analyzeLine, analyzeStation } from './features/analysis/engine.js';
import * as suggestions from './features/suggestions/service.js';
import * as compare from './features/compare/service.js';
import * as settings from './features/settings/service.js';

/**
 * API 路由表（见《MVP系统架构设计》§5）。Controller 层只做参数提取与返回，业务在 service/engine。
 */
export function buildRouter() {
  const r = new Router();

  r.get('/api/health', () => ({ status: 'ok', ts: new Date().toISOString() }));
  r.get('/api/ready', () => {
    getDb().prepare('SELECT 1 AS ok').get();
    return { status: 'ok', checks: { database: 'ok' } };
  });
  r.get('/api/rules', () => ruleSnapshot());

  // 产线 / 工位
  r.get('/api/lines', () => ({ lines: stations.listLines() }));
  r.get('/api/stations', (ctx) => ({ stations: stations.listStations(ctx.query.line_id) }));
  r.post('/api/stations', (ctx) => stations.createStation(ctx.body ?? {}));
  r.get('/api/stations/:id', (ctx) => stations.getStationDetail(ctx.params.id));
  r.patch('/api/stations/:id', (ctx) => stations.updateStation(ctx.params.id, ctx.body ?? {}));
  r.get('/api/stations/:id/versions', (ctx) => ({ versions: stations.listVersions(ctx.params.id) }));

  // 复测封存（v2.1补丁#1）
  r.post('/api/stations/:id/retest', (ctx) => stations.startRetest(ctx.params.id, ctx.body?.user));
  r.delete('/api/stations/:id/retest', (ctx) => stations.cancelRetest(ctx.params.id, ctx.query.user));

  // 要素：校验 / 提交 / 导入 / 导出 / 改判
  r.post('/api/stations/:id/elements/validate', (ctx) => validateSubmission(ctx.body ?? {}));
  r.post('/api/stations/:id/elements/submit', (ctx) => elements.submitElements(ctx.params.id, ctx.body ?? {}, ctx.body?.user));
  r.post('/api/stations/:id/import', (ctx) => elements.importCsv(ctx.params.id, ctx.body?.csv ?? '', ctx.body?.user));
  r.get('/api/stations/:id/export.csv', (ctx) => ({
    __raw: { contentType: 'text/csv; charset=utf-8', body: elements.exportCsv(ctx.params.id) },
  }));
  r.post('/api/elements/:id/va', (ctx) => elements.updateVAClass(ctx.params.id, ctx.body ?? {}, ctx.body?.user));
  r.post('/api/elements/:id/va-confirm', (ctx) => elements.confirmVAClass(ctx.params.id, ctx.body ?? {}, ctx.body?.user));

  // 分析引擎
  r.get('/api/stations/:id/analysis', (ctx) => {
    const station = stations.getStationRow(ctx.params.id);
    const version = ctx.query.version ? Number(ctx.query.version) : station.version;
    const list = stations.elementsOfVersion(station.station_id, version);
    return analyzeStation({ ...station, version }, list);
  });
  r.get('/api/lines/:lineId/analysis', (ctx) => analyzeLine(ctx.params.lineId));

  // 改善建议
  r.post('/api/stations/:id/suggestions/generate', (ctx) => suggestions.generateCandidates(ctx.params.id));
  r.post('/api/stations/:id/suggestions/adopt', (ctx) => suggestions.adoptCandidates(ctx.params.id, ctx.body ?? {}));
  r.get('/api/improvements', (ctx) => ({ improvements: suggestions.listImprovements(ctx.query) }));
  r.patch('/api/improvements/:id/status', (ctx) => suggestions.updateStatus(ctx.params.id, ctx.body ?? {}));
  r.get('/api/improvements/:id/report', (ctx) => suggestions.buildReport(ctx.params.id));

  // 对比与收益
  r.get('/api/stations/:id/compare', (ctx) => compare.compareVersions(ctx.params.id, ctx.query));
  r.get('/api/stations/:id/compare/report', (ctx) => compare.buildCompareReport(ctx.params.id, ctx.query));

  // 收益参数
  r.get('/api/config/benefit-params', (ctx) => {
    const lineId = ctx.query.line_id;
    if (!lineId) throw new BadRequestError('缺少 line_id');
    return { line_id: lineId, params: settings.getParams(lineId) };
  });
  r.put('/api/config/benefit-params', (ctx) => {
    const lineId = ctx.body?.line_id;
    if (!lineId) throw new BadRequestError('缺少 line_id');
    return { line_id: lineId, params: settings.saveParams(lineId, ctx.body) };
  });

  return r;
}
