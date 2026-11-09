import { Injectable } from '@nestjs/common';
import { BaseRepository } from '../database/base.repository';
import { RuleSet } from '../../entities/rule-set.entity';

/** 规则集仓库：规则库为全局共享数据（无租户列），仅复用事务执行器 */
@Injectable()
export class RuleSetRepository extends BaseRepository<RuleSet> {
  protected entityTarget() {
    return RuleSet;
  }
}
