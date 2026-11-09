import { Module } from '@nestjs/common';
import { ElementsController } from './elements.controller';
import { ElementsService } from './elements.service';
import { ElementRepository } from './element.repository';
import { StationsModule } from '../stations/stations.module';

/**
 * 要素分解模块（MVP features/elements 1:1 平移）：
 * V1/V2/V3 校验（纯函数） / 写守卫+事务提交 / CSV 整批导入导出 / VA 改判确认留痕。
 */
@Module({
  imports: [StationsModule],
  controllers: [ElementsController],
  providers: [ElementsService, ElementRepository],
  exports: [ElementsService],
})
export class ElementsModule {}
