import { Module } from '@nestjs/common';
import { OidcController } from './oidc.controller';
import { OidcClientService } from './oidc-client.service';
import { OidcStateStore } from './oidc-state.store';
import { SsoIdentityService } from './sso-identity.service';
import { SsoStatusSyncService } from './sso-status-sync.service';

/**
 * 统一身份认证模块。依赖 AuthModule（@Global，提供 AuthService/AuthUserLoader/JwtModule）
 * 与 AuditService（AuditModule @Global），不反向依赖业务模块。
 */
@Module({
  controllers: [OidcController],
  providers: [OidcClientService, OidcStateStore, SsoIdentityService, SsoStatusSyncService],
})
export class AuthOidcModule {}
