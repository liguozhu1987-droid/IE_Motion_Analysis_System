import { Module } from '@nestjs/common';
import { RolesController } from './roles.controller';
import { RolesService } from './roles.service';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [AuthModule], // 复用 AuthUserLoader（权限变更后即时失效成员缓存）
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
