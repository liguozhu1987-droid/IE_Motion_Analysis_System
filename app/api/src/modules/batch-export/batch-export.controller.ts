import { Controller, Get, Param, Query, Req, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser, AuthedRequest } from '../../auth/auth-user.interface';
import { AuditService } from '../../audit/audit.service';
import { BatchExportQueryDto } from './batch-export.dto';
import { BatchExportService } from './batch-export.service';
import { ExportArchiveService } from './export-archive.service';
import { buildWorkbook } from './workbook';
import { fileStamp } from './format';

/**
 * 批量导出端点（v1 不改库 MVP → v3.62 增加留档落库）。
 * 与单工位 CSV 导出同构：需认证、fetch+blob 下载；单工位 CSV 保持回导职责不变。
 *
 * 权限：element:read（必需，Guard 把关）+ 逐工位资源级可见性（Service 收口）；
 *       analysis:read 为可选降级——无该权限时 04_动作分析 整表不生成。
 * 安全：临时 URL 不存在（复下载走认证端点）、Cache-Control: no-store；
 *       请求里的不可见工位静默剔除（不回显存在性），聚合值在过滤后计算。
 * 留档（v3.62）：每次导出成功 → 文件落 storage/exports/<record_id>.xlsx + t_batch_export_record 登记；
 *       留档失败不阻断交付（archive 内部兜底）；复下载返回当时的快照文件，不重新计算。
 */
@Controller('export')
export class BatchExportController {
  constructor(
    private readonly service: BatchExportService,
    private readonly archive: ExportArchiveService,
    private readonly audit: AuditService,
  ) {}

  @Get('batch.xlsx')
  @RequirePermission('element:read')
  async exportXlsx(
    @Query() q: BatchExportQueryDto,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
    @Req() req: AuthedRequest,
  ): Promise<StreamableFile> {
    const model = await this.service.buildModel(q, user);
    const buffer = await buildWorkbook(model);

    const safeLine = String(model.meta.lineId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32);
    // Phase 2：文件名带任务号 + 时间段（封面 / 各表信息区 / 文件名三处同现，脱离系统仍可归档）
    const safeTask = model.meta.taskNo
      ? `${String(model.meta.taskNo).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)}_${model.meta.periodStart.replace(/-/g, '')}`
      : '';
    const stem = [safeTask, safeLine].filter(Boolean).join('_');
    const stamp = fileStamp(model.meta.exportedAt);
    const asciiName = `VA_analysis_${stem}_${stamp}.xlsx`;
    const cnName = `VA分析_${stem}_${stamp}.xlsx`;

    // 留档（v3.62）：失败不影响本次交付，仅少了历史记录
    const record = await this.archive.archive({
      user,
      lineId: model.meta.lineId,
      lineName: model.meta.lineName,
      taskId: model.meta.taskId,
      taskNo: model.meta.taskNo,
      stationCount: model.meta.stationCount,
      elementCount: model.meta.activeElementCount,
      focusCount: model.meta.focusCount,
      sheetCount: model.options.withFocus ? 6 : 5,
      withFocus: model.options.withFocus,
      includeOutliers: model.options.includeOutliers,
      includeUndecomposed: model.options.includeUndecomposed,
      focusTop: model.options.focusTop,
      downloadName: cnName,
      ruleVersions: Object.entries(model.meta.ruleVersions)
        .map(([k, v]) => `${k}:${v}`).join('|'),
      buffer,
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // RFC 5987：中文名用 filename*，同时给纯 ASCII filename 作老客户端回退
    res.setHeader('Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(cnName)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, X-Export-Stats, X-Export-Record-Id');
    // 纯 ASCII 统计值，前端下载完成后用于顶部提示（不含任何业务明细）
    res.setHeader('X-Export-Stats', JSON.stringify({
      stations: model.meta.stationCount,
      elements: model.meta.activeElementCount,
      focus: model.meta.focusCount,
      sheets: model.options.withFocus ? 6 : 5,
    }));
    if (record) res.setHeader('X-Export-Record-Id', record.record_id);

    // Phase 3 / #108（D6）：导出是 GET，全局审计拦截器只拦非 GET —— 必须业务侧显式自审计。
    // action 用固定业务值，不改 audit.interceptor 的 path 派生规则（A-108-2）；
    // 兼容模式 task_id / task_no 均为 null，绝不冒充任务号；复下载不写审计（A-108-3）。
    // AuditService.record 内部 .catch() 已吞异常，这里再兜一层 try/catch 保证零阻断。
    try {
      this.audit.record(
        user,
        'export_batch_xlsx',
        't_batch_export_record',
        record?.record_id ?? null,
        null,
        {
          task_id: model.meta.taskId ?? null,
          task_no: model.meta.taskNo ?? null,
          sheets: model.options.withFocus ? 6 : 5,
          station_count: model.meta.stationCount,
          element_count: model.meta.activeElementCount,
          line_id: model.meta.lineId,
        },
        String((req as any)?.ip ?? ''),
        model.meta.taskId ?? null,
      );
    } catch { /* 审计失败不阻断导出 */ }

    return new StreamableFile(buffer);
  }

  /** 历史导出列表：本人 ∪ 全权角色；租户隔离由 Repository 兜底 */
  @Get('batch/records')
  @RequirePermission('element:read')
  async listRecords(
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const n = Math.trunc(Number(limit));
    return { items: await this.archive.list(user, Number.isFinite(n) && n > 0 ? n : 20) };
  }

  /** 复下载：返回当时生成的快照文件（不重新计算）；可见性 = 本人 ∪ 全权（同租户），否则 404 不泄露存在性 */
  @Get('batch/records/:id/file')
  @RequirePermission('element:read')
  async downloadRecord(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, downloadName } = await this.archive.loadFile(id, user);
    const ascii = downloadName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="${ascii || 'export.xlsx'}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    return new StreamableFile(buffer);
  }
}
