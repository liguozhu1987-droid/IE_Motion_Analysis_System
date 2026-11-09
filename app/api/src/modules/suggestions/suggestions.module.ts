import { Module } from '@nestjs/common';
import { SuggestionsController, ImprovementsController } from './suggestions.controller';
import { SuggestionsService } from './suggestions.service';
import { ImprovementRepository } from '../compare/improvement.repository';
import { AnalysisModule } from '../analysis/analysis.module';
import { StationsModule } from '../stations/stations.module';

/**
 * 改善建议模块（MVP suggestions/service.js 1:1 平移）：
 * 12 条 ECRSA 映射 / 三因子优先级（est_save_s×日频次÷difficulty，归一化分档）/
 * 预对专项（M06/M09）/ 2 条红线（品质+人因，确认后放行）/
 * 候选不落库、采纳才写 t_improvement / 三态流转（已验证要求复测版+回填 after_ct）/
 * 建议书一页数据。
 * ImprovementRepository 与 compare 模块共用同一实体仓库类（无状态，DataSource 全局）。
 */
@Module({
  imports: [AnalysisModule, StationsModule],
  controllers: [SuggestionsController, ImprovementsController],
  providers: [SuggestionsService, ImprovementRepository],
  exports: [SuggestionsService],
})
export class SuggestionsModule {}
