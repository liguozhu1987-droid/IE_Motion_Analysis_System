import { Module, Global } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { APP_CONFIG, loadConfig } from './configuration';

@Global()
@Module({
  imports: [NestConfigModule.forRoot({ isGlobal: true, load: [loadConfig] })],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
  ],
  exports: [APP_CONFIG],
})
export class AppConfigModule {}
