import { Injectable } from '@nestjs/common';
import { BaseRepository } from '../../core/database/base.repository';
import { Element } from '../../entities/element.entity';

/** 要素仓库：继承租户安全基类（查询自动附加 tenant_id，防跨租户串读） */
@Injectable()
export class ElementRepository extends BaseRepository<Element> {
  protected entityTarget() {
    return Element;
  }
}
