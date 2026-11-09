import { Module } from '@nestjs/common';
import { StationAnalysisController, LineAnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { StationsModule } from '../stations/stations.module';

/**
 * 分析引擎模块（MVP analysis/engine.js 1:1 平移）：
 * VA 归类（标记优先→例外→默认）/ 6 类浪费（元素级+工位级聚合）/
 * 双手图 / 单工位指标 / 产线山积图+平衡率+瓶颈榜。
 * 引擎为纯函数（规则注入），供 suggestions/compare 模块复用。
 * v3.55：控制器需 StationsService 做可见范围判定 → 引入 StationsModule（单向依赖，无环）。
 */
@Module({
  imports: [StationsModule],
  controllers: [StationAnalysisController, LineAnalysisController],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
