import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthUserLoader } from './auth-user.loader';
import { APP_CONFIG } from '../core/config/configuration';
import { AppConfig } from '../core/config/configuration';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => ({ secret: cfg.jwtAccessSecret }), // access token 密钥（refresh 用独立 secret）
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, AuthUserLoader],
  exports: [AuthService, JwtAuthGuard, AuthUserLoader, JwtModule],
})
export class AuthModule {}
