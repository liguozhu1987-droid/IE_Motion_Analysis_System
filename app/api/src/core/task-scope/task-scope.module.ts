import { Global, Module } from '@nestjs/common';
import { TaskScopeService } from './task-scope.service';

/**
 * 任务上下文模块设为 @Global：analysis / elements / compare / suggestions /
 * dashboard / lines / stations 等模块都要解析任务上下文，逐个改 imports 会引入
 * StationsModule ↔ TasksModule 的循环依赖。本模块只依赖 DataSource，无环。
 */
@Global()
@Module({
  providers: [TaskScopeService],
  exports: [TaskScopeService],
})
export class TaskScopeModule {}
