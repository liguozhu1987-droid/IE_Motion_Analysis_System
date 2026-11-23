// 动作标准离线回归共享入口：仅转发被测纯函数（esbuild 打包成 CJS）
export {
  parseDescToFields, parseFormat, buildPreview, motionFormatHint,
  reachOptionsFor, BODY_REACH, EYE_REACH, REACH_LEGACY,
} from '../src/motionStandard.ts';