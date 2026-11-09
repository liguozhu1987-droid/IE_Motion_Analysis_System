import { Module } from '@nestjs/common';
import { AiWasteStationController, AiWasteIssueController, AiWasteManualController } from './ai-waste.controller';
import { AiWasteService } from './ai-waste.service';
import { AnalysisModule } from '../analysis/analysis.module';
import { StationsModule } from '../stations/stations.module';

/**
 * P3-9 浪费识别 + 改善问题清单模块（AI 自动分解线专用）。
 *
 * 边界铁律（用户裁定）：与分解工作台 AI 建议模块（ai-suggest）相互独立——
 *  - 独立三表（t_ai_waste_batch / t_ai_waste_finding / t_ai_waste_issue）
 *  - 独立校验引擎（W1-W3）与独立打分口径（E 全额 / C·R·S×0.5；tier 按占比归一化）
 *  - 只处理 source='ai_assisted' 要素；不 import ai-suggest 任何 service/validator/calculator
 *  - 复用仅限公共基建：AnalysisModule 分析口径 / 全局 AiModule 的 LlmGatewayService /
 *    t_ai_setting 生效配置 / 动态浪费白名单（RulesService）
 */
@Module({
  imports: [AnalysisModule, StationsModule],
  controllers: [AiWasteStationController, AiWasteIssueController, AiWasteManualController],
  providers: [AiWasteService],
  exports: [AiWasteService],
})
export class AiWasteModule {}
