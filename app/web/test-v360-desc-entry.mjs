// v3.60 测试入口：仅转发被测纯函数（esbuild 打包成 CJS 供 test-v360-desc-backfill.cjs 断言）
export { parseDescToFields, parseFormat, buildPreview, motionFormatHint } from './src/motionStandard.ts';
