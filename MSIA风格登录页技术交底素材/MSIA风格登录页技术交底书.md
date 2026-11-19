# MSIA 风格统一登录页技术交底书

## 1. 目的与适用范围

本文沉淀 MSIA Report 登录页的视觉规范，便于在 BOL 及其他内部系统中复用，形成统一、易识别的企业登录体验。文中只定义前端展示层；接入时应沿用目标系统现有认证 API、OIDC 跳转、表单校验、访客入口和错误提示，不改动后端用户管理或权限逻辑。

原始设计参考：`MSIA Report/frontend/src/pages/Login.tsx`、`MSIA Report/frontend/src/index.css`。BOL 适配实现：`BOL管理系统/frontend/src/views/LoginView.vue`。

## 2. 视觉基调

- 风格：柔和科技商务风（Soft-Tech Business），以深湖蓝、青碧色和云雾白为主。
- 背景：使用系统可随包部署的本地图片，铺满视口并居中裁切；叠加深蓝渐变蒙层，保证前景内容清晰。
- 装饰：蓝/青色低透明度径向光斑；可添加少量低对比度呼吸光点。
- 内容布局：登录卡片水平、垂直居中；卡片内从上至下为品牌图、系统名称、英文副标题、登录提示、认证入口及辅助入口。
- 卡片：白色半透明玻璃质感、大圆角、柔和多层阴影和轻度背景模糊；顶部以细蓝青渐变光条强调层次。
- 品牌：使用统一的企业标识，但系统名称和英文副标题必须保留目标系统自己的名称。

## 3. 推荐设计参数

| 元素 | 规范 |
|---|---|
| 主蓝 | `#2E5CE6` |
| 深蓝 | `#1E46C0` |
| 浅蓝 | `#6B93F0` |
| 青碧 | `#0FB5BA` |
| 主文字 | `#1B2540` |
| 次级文字 | `#5D6B8A` |
| 背景蒙层 | `linear-gradient(135deg, rgba(30,70,192,.54), rgba(15,37,88,.82))` |
| 卡片 | 最大宽度约 `420px`；白色透明度约 `0.94`；圆角 `18px`；模糊 `18px` |
| 品牌图 | 高度约 `48px`；等比缩放；置于圆角浅色底框中 |
| 认证按钮 | 蓝到青渐变；圆角 `10px`；高度 `44–50px`；柔和蓝色阴影 |
| “统一身份登录” | 原 MSIA 设计采用 `letter-spacing: 4px`；BOL 为提高辨识度采用 `17px`、`font-weight: 700`、`letter-spacing: 3px` |
| 小屏幕 | 视口宽度不超过 `480px` 时缩小卡片内边距及标题字号，卡片宽度保持自适应 |

## 4. 结构与样式落地

### 4.1 页面层级

```text
LoginPage
├── BackgroundImage + BlueOverlay
├── AmbientGlow (decorative, pointer-events: none)
└── CenteredLoginCard
    ├── BrandLogo
    ├── SystemName + EnglishCaption
    ├── LoginHint
    ├── OIDCButton (only when enabled)
    ├── ExistingLocalLogin (only when enabled)
    └── ExistingGuestOrHelpLinks
```

使用本地静态资源，避免部署环境依赖外网：

```css
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  padding: 32px 20px;
}

.login-background {
  position: fixed;
  inset: 0;
  background: url('/login-bg.png') center / cover no-repeat;
}

.login-background::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    135deg,
    rgba(30, 70, 192, 0.54) 0%,
    rgba(15, 37, 88, 0.82) 100%
  );
}

.login-card {
  width: min(100%, 440px);
  border: 0;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow:
    0 8px 32px rgba(11, 26, 64, 0.22),
    0 24px 64px rgba(11, 26, 64, 0.18),
    0 0 0 1px rgba(255, 255, 255, 0.35);
  backdrop-filter: blur(18px) saturate(170%);
}

.oidc-button {
  min-height: 50px;
  border: 0;
  border-radius: 10px;
  color: #fff;
  background: linear-gradient(135deg, #2e5ce6 0%, #0fb5ba 100%);
  box-shadow: 0 6px 20px rgba(46, 92, 230, 0.32);
  font-size: 17px;
  font-weight: 700;
  letter-spacing: 3px;
}

@media (max-width: 480px) {
  .login-card {
    padding: 28px 22px;
  }
}
```

以上为跨框架的样式参考；在 Vue、React 或其他框架中，应使用目标项目现有组件和样式机制实现，不需要引入新的 UI 框架。

### 4.2 品牌区

- Logo 以 `object-fit: contain` 保持比例，建议显示高度 `48px`。
- Logo 容器使用 `9px 22px` 内边距、`12px` 圆角、浅蓝/浅青渐变底色和低对比度边框。
- 系统名称居中显示，使用深色文字、约 `22px` 字号、`700` 字重。
- 英文副标题使用约 `10–12px` 字号和 `1.2px` 字间距；名称需按目标系统替换。

### 4.3 统一身份入口

- 入口由后端公开认证配置决定是否显示；按钮只负责调用原有 OIDC 跳转方法。
- 登录配置、回调地址、账号校验、错误处理、会话持久化均继续由目标系统既有实现负责。
- 按钮应有清晰键盘焦点样式和可访问名称。仅当统一身份认证实际启用时显示该入口。
- 若保留本地登录，应继续遵循既有配置开关和过渡期展示规则；不把账号密码逻辑移入样式层。

## 5. 跨系统复用步骤

1. 将背景图和企业 Logo 放入目标前端的 `public/` 或等价静态资源目录；使用本地绝对路径引用，并确认构建结果包含这些图片。
2. 将页面背景、蒙层、氛围光效、居中卡片、品牌区、主按钮样式移植到目标系统。
3. 把系统名称、英文副标题、背景图、Logo 设为该系统自身内容；不要把 MSIA 的系统名称复制到其他产品。
4. 将新样式套在现有登录组件外观上，保留原有认证状态、API 请求、跳转、校验、游客访问和提示逻辑。
5. 在无后端配置、OIDC 开启、本地登录开启/关闭和窄屏视口下检查显示；构建后确认静态资源路径及入口文件完整。

## 6. 本次 BOL 适配记录

- BOL 页面显示名称为“BOL 管理分析平台”，没有更改任何后端用户管理逻辑。
- 背景图使用 `BOL管理系统/frontend/public/login-bg.png`，品牌图使用 `BOL管理系统/frontend/public/login-logo.png`。
- OIDC、本地登录折叠面板、游客访问、注册与密码自助入口继续沿用 BOL 原有配置和处理函数。
- 登录页只调整布局和样式；BOL 前端构建已验证通过。

## 7. 安全与部署注意

- 不在前端代码、文档或静态资源中放置数据库口令、OIDC 客户端密钥或其他凭据。
- 登录 UI 改版不构成身份认证或授权变更；认证端点与回调地址应继续由后端配置管理。
- 使用项目现有依赖和构建产物；图片随包部署，不从外部 CDN 临时加载。
- 检查移动端可读性、按钮对比度、键盘可达性和系统缩放效果。
