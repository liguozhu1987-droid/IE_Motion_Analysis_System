import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AuthModule } from '../../auth/auth.module';

@Module({
  imports: [AuthModule], // 复用 AuthService（代置口令/下发码/会话吊销）与 AuthUserLoader
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
