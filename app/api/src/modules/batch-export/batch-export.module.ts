import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module';
import { TasksModule } from '../decomposition-tasks/tasks.module';
import { BatchExportController } from './batch-export.controller';
import { BatchExportService } from './batch-export.service';
import { ExportArchiveService } from './export-archive.service';

/**
 * 批量导出模块（v1 不改库 MVP → v3.62 留档落库）：
 * 取数（两条 SQL + 可见范围过滤）→ 复用分析引擎 → 派生四类时间/焦点 → exceljs 生成固定 6 张 sheet
 * → 留档（storage/exports/<record_id>.xlsx + t_batch_export_record 登记 + 历史列表/复下载）。
 * 不改既有表、不回写 ST、不改 va_class、不删除任何要素（RNVA 只压不删）；不下发 AI 模块数据。
 */
@Module({
  imports: [StationsModule, TasksModule],
  controllers: [BatchExportController],
  providers: [BatchExportService, ExportArchiveService],
  exports: [BatchExportService, ExportArchiveService],
})
export class BatchExportModule {}
