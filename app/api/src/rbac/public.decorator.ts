import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'is_public';
/** 标记路由无需登录（login/refresh/health 等） */
export const Public = () => SetMetadata(IS_PUBLIC, true);
