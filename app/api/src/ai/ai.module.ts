import { Global, Module } from '@nestjs/common';
import { AiTaskService } from './ai-task.service';
import { AiController } from './ai.controller';
import { LlmGatewayService } from './llm-gateway.service';
import { AiUsageService } from './ai-usage.service';
import { StationsModule } from '../modules/stations/stations.module';

@Global()
@Module({
  imports: [StationsModule],
  providers: [AiTaskService, LlmGatewayService, AiUsageService],
  controllers: [AiController],
  exports: [AiTaskService, LlmGatewayService, AiUsageService],
})
export class AiModule {}
