import { Global, Module } from '@nestjs/common';
import { RulesService } from './rules.service';
import { RulesController } from './rules.controller';

@Global()
@Module({
  providers: [RulesService],
  controllers: [RulesController],
  exports: [RulesService],
})
export class RulesModule {}
