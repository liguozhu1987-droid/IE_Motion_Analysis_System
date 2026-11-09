import { Module } from '@nestjs/common';
import { AiInsightService } from './ai-insight.service';
import { AiInsightController } from './ai-insight.controller';
import { AnalysisModule } from '../analysis/analysis.module';
import { CompareModule } from '../compare/compare.module';
import { StationsModule } from '../stations/stations.module';

/**
 * AI 洞察模块（v3.53）：统一收敛「诊断 / 解读」纯文案生成。
 * 复用全局 AiModule 的 LlmGatewayService（@Global 已导出），并 import Analysis/Compare 两模块拿其 Service。
 * 不新建 LLM 调用链、不改计算口径。
 */
@Module({
  imports: [AnalysisModule, CompareModule, StationsModule],
  controllers: [AiInsightController],
  providers: [AiInsightService],
  exports: [AiInsightService],
})
export class AiInsightModule {}
