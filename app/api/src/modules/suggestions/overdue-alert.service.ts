import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** v3.66 P2：改善任务超期提醒。与 ImprovementsController 同模块（/improvements 命名空间）。 */
const OVERDUE_WHERE = `status IN (N'待实施', N'进行中') AND due < GETDATE()`;

@Injectable()
export class OverdueAlertService {
  private readonly log = new Logger('OverdueAlert');

  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** 查询超期任务数（供前端 badge 显示） */
  async count(): Promise<number> {
    try {
      const rows = await this.ds.query(`SELECT COUNT(*) AS c FROM t_improvement WHERE ${OVERDUE_WHERE}`);
      return Number(rows[0]?.c ?? 0);
    } catch (e) {
      this.log.warn(`超期计数失败：${(e as Error).message}`);
      return 0;
    }
  }

  /** 扫描超期并标记 notified 时间（每天最多一次，由定时调用者触发） */
  async scanAndMark(): Promise<{ overdue: string[]; previousNotified: string[] }> {
    try {
      const rows = await this.ds.query(
        `SELECT imp_id, station_id, owner, measure, due, status, overdue_notified_at
         FROM t_improvement WHERE ${OVERDUE_WHERE}`);
      const fresh = rows.filter((r: any) => !r.overdue_notified_at);
      const prevNotified = rows.filter((r: any) => r.overdue_notified_at);
      if (fresh.length > 0) {
        const params: any[] = [];
        const ph = fresh.map((r: any, i: number) => { params.push(r.imp_id); return `@p${i}`; }).join(',');
        await this.ds.query(
          `UPDATE t_improvement SET overdue_notified_at = GETDATE() WHERE imp_id IN (${ph})`, params);
        this.log.log(`超期提醒：${fresh.length} 条新超期（累计 ${rows.length} 条）`);
        for (const r of fresh) {
          this.log.warn(`  [${r.status}] ${r.station_id} · ${r.owner ?? '未指定责任人'} · 截止 ${String(r.due).slice(0, 10)} · ${String(r.measure ?? '').slice(0, 60)}`);
        }
      }
      return {
        overdue: fresh.map((r: any) => `${r.station_id}·${r.imp_id.slice(0, 8)}`),
        previousNotified: prevNotified.map((r: any) => r.imp_id.slice(0, 8)),
      };
    } catch (e) {
      this.log.warn(`超期扫描失败：${(e as Error).message}`);
      return { overdue: [], previousNotified: [] };
    }
  }
}