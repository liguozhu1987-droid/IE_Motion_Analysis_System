import { Module } from '@nestjs/common';
import { LinesController } from './lines.controller';
import { ProjectsController } from './projects.controller';
import { StationsModule } from '../stations/stations.module';

/**
 * 产线概览（导航树数据源）：依赖全局 RulesModule（analyzeStation 需规则集）。
 * v3.55：依赖 StationsModule 做可见范围收口（单向依赖，无环）。
 */
@Module({
  imports: [StationsModule],
  controllers: [LinesController, ProjectsController],
})
export class LinesModule {}
