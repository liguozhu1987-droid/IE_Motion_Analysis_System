import { Injectable } from '@nestjs/common';
import { BaseRepository } from '../../core/database/base.repository';
import { Improvement } from '../../entities/improvement.entity';

/** 改善建议仓库：继承租户安全基类 */
@Injectable()
export class ImprovementRepository extends BaseRepository<Improvement> {
  protected entityTarget() {
    return Improvement;
  }
}
