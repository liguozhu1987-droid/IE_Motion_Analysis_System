import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { TenantController } from './tenant.controller';

@Module({ controllers: [SettingsController, TenantController] })
export class SettingsModule {}
