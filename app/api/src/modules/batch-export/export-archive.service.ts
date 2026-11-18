import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DataSource } from 'typeorm';
import { BaseRepository } from '../../core/database/base.repository';
import { BatchExportRecord } from '../../entities/batch-export-record.entity';
import { AuthUser } from '../../auth/auth-user.interface';
import { hasFullAccess } from '../../rbac/full-access';

class BatchExportRecordRepository extends BaseRepository<BatchExportRecord> {
  protected entityTarget() {
    return BatchExportRecord;
  }
}

export interface ArchiveParams {
  user: AuthUser;
  lineId: string;
  lineName: string;
  /** Phase 2：导出所属分解任务（按产线兼容模式为 null，不回写 v3.62 存量记录） */
  taskId: string | null;
  taskNo: string | null;
  stationCount: number;
  elementCount: number;
  focusCount: number;
  sheetCount: number;
  withFocus: boolean;
  includeOutliers: boolean;
  includeUndecomposed: boolean;
  focusTop: number;
  downloadName: string;
  ruleVersions: string;
  buffer: Buffer;
}

export interface ExportRecordDto {
  record_id: string;
  created_at: string;
  username: string;
  line_id: string;
  line_name: string;
  task_id: string | null;
  task_no: string | null;
  station_count: number;
  element_count: number;
  focus_count: number;
  sheet_count: number;
  file_size: number;
  status: string;
  download_count: number;
  with_focus: boolean;
  include_outliers: boolean;
  include_undecomposed: boolean;
  focus_top: number;
}

/**
 * 批量导出留档（v3.62）：文件落 storage/exports/<record_id>.xlsx + t_batch_export_record 登记。
 *
 * 纪律：
 *  - 留档失败不阻断交付：archive 内部兜底，落盘失败写 status='missing' 行，DB 失败清理孤儿文件；
 *  - 可见性 = 本人 ∪ 全权角色（hasFullAccess），跨租户由 Repository 行级过滤硬隔离；
 *  - 复下载不重新计算——返回当时生成的那份文件（快照语义），download_count / last_downloaded_at 每次自增。
 */
@Injectable()
export class ExportArchiveService {
  private readonly log = new Logger(ExportArchiveService.name);
  private readonly dir = path.resolve(process.cwd(), 'storage', 'exports');
  private readonly repo: BatchExportRecordRepository;

  constructor(@InjectDataSource() private readonly ds: DataSource) {
    this.repo = new BatchExportRecordRepository(ds);
  }

  /** 导出成功后调用：先落盘再登记；任何失败不抛出（不影响本次下载交付） */
  async archive(p: ArchiveParams): Promise<BatchExportRecord | null> {
    const recordId = randomUUID();
    const fileName = `${recordId}.xlsx`;
    let saved = false;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(path.join(this.dir, fileName), p.buffer);
      saved = true;
    } catch (e) {
      // 落盘失败：仍登记（历史可查），状态 missing，复下载报 404
      this.log.error(`导出文件落盘失败（记录仍登记为 missing）: ${(e as Error).message}`);
    }
    try {
      const row = await this.repo.create({
        record_id: recordId,
        user_id: p.user.userId,
        username: p.user.displayName || p.user.username,
        line_id: p.lineId,
        line_name: p.lineName,
        task_id: p.taskId,
        task_no: p.taskNo,
        station_count: p.stationCount,
        element_count: p.elementCount,
        focus_count: p.focusCount,
        sheet_count: p.sheetCount,
        with_focus: p.withFocus,
        include_outliers: p.includeOutliers,
        include_undecomposed: p.includeUndecomposed,
        focus_top: p.focusTop,
        file_name: saved ? fileName : '',
        file_size: saved ? p.buffer.length : 0,
        download_name: p.downloadName,
        rule_versions: p.ruleVersions.slice(0, 256),
        status: saved ? 'ready' : 'missing',
      } as Partial<BatchExportRecord>);
      return row;
    } catch (e) {
      this.log.error(`导出留档登记失败（不影响本次下载）: ${(e as Error).message}`);
      if (saved) {
        try { await unlink(path.join(this.dir, fileName)); } catch { /* 清理失败仅留孤儿文件，无数据风险 */ }
      }
      return null;
    }
  }

  /** 历史列表：本人 ∪ 全权角色；租户隔离由 Repository 兜底 */
  async list(user: AuthUser, limit: number): Promise<ExportRecordDto[]> {
    const take = Math.min(Math.max(1, limit), 100);
    const rows = hasFullAccess(user.roles)
      ? await this.repo.find({}, { order: { created_at: 'DESC' }, take })
      : await this.repo.find({ user_id: user.userId }, { order: { created_at: 'DESC' }, take });
    return rows.map((r) => this.toDto(r));
  }

  /** 复下载：可见性 = 本人 ∪ 全权（同租户）；文件缺失时把行标 missing 再 404 */
  async loadFile(recordId: string, user: AuthUser): Promise<{ buffer: Buffer; downloadName: string }> {
    const row = await this.repo.findOne({ record_id: recordId });
    if (!row) throw new NotFoundException('导出记录不存在');
    if (!hasFullAccess(user.roles) && row.user_id !== user.userId) {
      // 不回显存在性：与工位静默剔除同口径，一律 404
      throw new NotFoundException('导出记录不存在');
    }
    if (row.status !== 'ready' || !row.file_name) {
      throw new NotFoundException('导出文件已被清理，无法复下载');
    }
    let buffer: Buffer;
    try {
      buffer = await readFile(path.join(this.dir, row.file_name));
    } catch (e) {
      this.log.warn(`导出文件读取失败，标记 missing: ${row.file_name} (${(e as Error).message})`);
      row.status = 'missing';
      await this.ds.getRepository(BatchExportRecord).save(row);
      throw new NotFoundException('导出文件已被清理，无法复下载');
    }
    // 复下载计数：等待写回完成（保证列表读回即得），失败仅记日志不阻断交付
    row.download_count += 1;
    row.last_downloaded_at = new Date();
    try {
      await this.ds.getRepository(BatchExportRecord).save(row);
    } catch (e) {
      this.log.warn(`复下载计数更新失败: ${(e as Error).message}`);
    }
    return { buffer, downloadName: row.download_name || `${row.record_id}.xlsx` };
  }

  private toDto(r: BatchExportRecord): ExportRecordDto {
    return {
      record_id: r.record_id,
      created_at: (r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at))).toISOString(),
      username: String(r.username ?? ''),
      line_id: r.line_id,
      line_name: String(r.line_name ?? r.line_id),
      task_id: r.task_id ?? null,
      task_no: r.task_no ?? null,
      station_count: Number(r.station_count),
      element_count: Number(r.element_count),
      focus_count: Number(r.focus_count),
      sheet_count: Number(r.sheet_count),
      file_size: Number(r.file_size),
      status: r.status,
      download_count: Number(r.download_count),
      with_focus: Boolean(r.with_focus),
      include_outliers: Boolean(r.include_outliers),
      include_undecomposed: Boolean(r.include_undecomposed),
      focus_top: Number(r.focus_top),
    };
  }
}
