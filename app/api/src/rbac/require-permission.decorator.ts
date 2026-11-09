import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSIONS = 'require_permissions';
/**
 * 声明接口所需权限点（满足其一即可）。
 * 未标注 @Public 且未标注 @RequirePermission 的路由 → 默认拒绝（安全默认）。
 * 例：@RequirePermission('station:write')
 */
export const RequirePermission = (...codes: string[]) => SetMetadata(REQUIRE_PERMISSIONS, codes);
