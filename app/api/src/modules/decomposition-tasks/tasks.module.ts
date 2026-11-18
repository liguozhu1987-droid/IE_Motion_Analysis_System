import { Module } from '@nestjs/common';
import { StationsModule } from '../stations/stations.module';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * 分解任务模块（Phase 2）：t_decomposition_task / t_task_station 的 CRUD、任务号生成、
 * 工位纳入与基线要素复制。RulesService 由全局 RulesModule 提供。
 * 导出 TasksService 供批量导出模块按任务取数（assertTaskReadable 单一口径）。
 */
@Module({
  imports: [StationsModule],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
