import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../rbac/require-permission.decorator';
import { CurrentUser } from '../../rbac/current-user.decorator';
import { AuthUser } from '../../auth/auth-user.interface';
import { TasksService } from './tasks.service';
import { AddStationsDto, CloneElementsDto, CreateTaskDto, ListTasksDto } from './tasks.dto';

/**
 * 分解任务端点（Phase 2 / 定稿 §3.8）。
 *
 * 权限：读 element:read（与批量导出一致）/ 写 element:write；
 *       任务级 tenant 隔离由 TasksService.assertTaskReadable 收口，工位级仍逐工位走 ACL。
 * 产线在这里只是任务下拉的**筛选器**，不再是独立导出范围（方案 §3.8）。
 */
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @RequirePermission('element:read')
  async list(@Query() q: ListTasksDto, @CurrentUser() user: AuthUser) {
    return this.tasks.list(q, user);
  }

  @Get(':id')
  @RequirePermission('element:read')
  async detail(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.tasks.detail(id, user);
  }

  @Post()
  @RequirePermission('element:write')
  async create(@Body() body: CreateTaskDto, @CurrentUser() user: AuthUser) {
    return this.tasks.create(body, user);
  }

  @Post(':id/stations')
  @RequirePermission('element:write')
  async addStations(@Param('id') id: string, @Body() body: AddStationsDto, @CurrentUser() user: AuthUser) {
    return this.tasks.addStations(id, body, user);
  }

  /** 从基线任务复制要素快照；新任务导出的要素集合与源任务互不串 */
  @Post(':id/clone-elements')
  @RequirePermission('element:write')
  async cloneElements(@Param('id') id: string, @Body() body: CloneElementsDto, @CurrentUser() user: AuthUser) {
    return this.tasks.cloneElements(id, body, user);
  }
}
