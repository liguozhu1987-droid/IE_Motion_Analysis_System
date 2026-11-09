import { Module } from '@nestjs/common';
import { CompareController } from './compare.controller';
import { CompareService } from './compare.service';
import { ImprovementRepository } from './improvement.repository';
import { AnalysisModule } from '../analysis/analysis.module';
import { StationsModule } from '../stations/stations.module';

/**
 * 对比收益模块（MVP compare/service.js 1:1 平移）：
 * 三层配对（L1 精确 / L2 相似度≥0.75 / L3 消除）、ΔCT 权威口径、
 * 收益估算（参数未配置即阻断）、一页对比报告。
 * v3.55：控制器需 StationsService 做可见范围判定。
 */
@Module({
  imports: [AnalysisModule, StationsModule],
  controllers: [CompareController],
  providers: [CompareService, ImprovementRepository],
  exports: [CompareService],
})
export class CompareModule {}
