import { Module } from '@nestjs/common';
import {
  AiSuggestStationController, AiSuggestionController,
  AiDictController, AiQuotaController, AiConfigController,
} from './ai-suggest.controller';
import { AiSuggestService } from './ai-suggest.service';
import { AnalysisModule } from '../analysis/analysis.module';
import { StationsModule } from '../stations/stations.module';

/**
 * AI 改善建议模块（合并实施规格书 §1-§5）。
 * 数据层 3 表（t_ai_suggestion_batch / t_ai_suggestion / t_ai_custom_dict）+ 4 增量列；
 * 三轮校验引擎（validator.ts 纯函数）；数字计算（calculator.ts，铁律②）；
 * 6 组端点（generate/list/adopt/reject/dict/quota/config）；
 * 幂等槽位（200/409/429）+ single-flight + 配额同事务自增。
 * 复用全局 AiModule 的 LlmGatewayService（熔断/月度 token），AI_SUGGEST_ENABLED=false 默认关闭。
 */
@Module({
  imports: [AnalysisModule, StationsModule],
  controllers: [
    AiSuggestStationController, AiSuggestionController,
    AiDictController, AiQuotaController, AiConfigController,
  ],
  providers: [AiSuggestService],
  exports: [AiSuggestService],
})
export class AiSuggestModule {}
