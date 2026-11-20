# MSIA 风格登录页改造 · 交接记录

- 日期：2026-11-19
- 任务：按 `MSIA风格登录页技术交底素材/MSIA风格登录页技术交底书.md` 改造本系统登录前端 UI，要求风格与背景一致。
- 范围：仅前端展示层；**未改认证 API、OIDC 跳转、本地/统一双轨开关、权限分流或错误处理**。

## 改了什么

| 文件 | 改动 |
|---|---|
| `app/web/src/pages/LoginPage.tsx` | 去掉原「左侧铭牌 + 右侧作业单」双栏；改为交底书规定的居中卡片：品牌图 → 系统名 + 英文副标题 → 登录提示 → 统一身份入口 → 本地登录 → 辅助入口。保留原有全部认证逻辑。 |
| `app/web/src/styles/login.css` | 重写认证层样式：本地背景图 + 深蓝渐变蒙层 + 蓝/青低透明光斑 + 440px 白色玻璃卡片（18px 圆角、模糊、多层阴影、顶部蓝青光条）；主按钮蓝青渐变；输入框/聚焦/错误提示同步。 |
| `app/web/public/login-bg.png` | 从交底素材复制，随包部署，不依赖外网。 |
| `app/web/public/login-logo.png` | 从交底素材复制；置于浅蓝/青圆角底框，高 48px。 |
| 其他认证页 | 注册/找回密码/强制改密/SSO 回调共用 `.login-card`，因此同步获得新背景与玻璃卡片；主按钮与输入框也统一为蓝青认证样式。 |

## 保留的行为

- `api.authConfig()` 拉取开关；失败时按「本地登录可用、SSO 不展示」兜底。
- OIDC 开启时显示「统一身份登录」，调用原 `api.oidcLoginUrl()`。
- 本地登录开关、注册/找回密码入口、首次登录强制改密、权限分流（`group:read` → 驾驶舱，否则工位）全部未改。
- 登录须知（连续输错锁定、首次改密、数据可见范围）折叠保留。
- 未引入新 UI 框架；只改现有 React 组件与 CSS。

## 验证（实际输出）

| 命令 | 输出 |
|---|---|
| `cd app/web && npm run typecheck` | **EXIT=0**（`tsc --noEmit -p tsconfig.json` 无错误） |
| `cd app/web && npm run test:css-classes` | **EXIT=0**；`合计未定义: 0`，PASS |
| 真实 Chrome 截图（1440×900） | 卡片 440×603.6，居中；`document.scrollWidth = clientWidth = 1440`（无横向溢出） |
| 真实 Chrome 截图（400×820） | 卡片 368×599.4，左右 16px 沟槽；`scrollWidth = clientWidth = 400`（无横向溢出） |
| OIDC 开启态（Puppeteer 拦截 `/api/auth/config` 返回 `oidcEnabled=true`） | 主按钮「统一身份登录」蓝青渐变；本地登录降为描边按钮；卡片高 723.5，900px 视口内完整显示 |
| 找回密码页 | 卡片 440×328，居中；按钮为蓝青渐变、输入框 44px；无横向溢出 |

> OIDC 截图中的开关是**前端 mock**，用于验证布局；真实统一身份入口仍由后端 `/api/auth/config` 与 OIDC 配置决定。当前生产配置 `AI_ENABLED=false`、OIDC 未启用时，登录页显示本地登录（主按钮蓝青渐变）。

## 截图

- `desktop.png`：默认配置（OIDC 关闭）桌面
- `phone.png`：400px 窄屏
- `sso-enabled.png`：OIDC 开关开启（mock）双轨布局
- `forgot.png`：找回密码页（共用认证层样式）

## 交接注意

- 背景/Logo 使用本地静态资源；替换品牌时只需替换 `app/web/public/login-bg.png` 与 `login-logo.png`，**不要**把 MSIA 的系统名称复制到本系统。
- 登录页视觉为固定深蓝/白玻璃风格，不随应用暗色主题反转；这是交底书的单一样式要求。
- 若后续启用 OIDC，请以真实 `/api/auth/config` 返回为准，不要以 mock 截图作为联调证据。
- 未提交的改动以 `git status` 为准；本次改动提交后应在看板/当日日志同步状态。
