/**
 * 视频派生 API 封装（SPEC-VID-P0 §4；后端契约见 app/api/src/modules/videos/derivative.controller.ts）。
 * 鉴权范式（与现有 videos 模块一致）：
 *  - derive / list / meta 走 request 核心（Bearer 头，401 自动刷新重放）；
 *  - 文件下发（fileUrl）是 @Public + ?token= 查询参数——<video>/<img> 标签发不了 Authorization 头。
 * :name = 源视频文件名 uuid.mp4（后端 filePathOf 白名单同款，防路径穿越）。
 */
import { apiUrlWithToken, request } from '../api';

/** 派生类型（SPEC-VID-P0 §3 表 t_video_derivative.kind） */
export type DerivativeKind = 'proxy' | 'sprite' | 'index';
/** 可下发文件的派生类型（端点 3 仅 proxy / sprite；index 只走 meta） */
export type DerivativeFileKind = 'proxy' | 'sprite';
/**
 * 派生状态机（§5：pending → running → ready 填 meta / error 且 retry<2 自动重入）
 * evicted：P0-1 磁盘治理 LRU 已淘汰代理（源视频保留）；前端按终态回落原视频，不空轮询。
 */
export type DerivativeStatus = 'pending' | 'running' | 'ready' | 'error' | 'evicted';

/** 派生 meta 视图（端点 1/2/4 返回形状；不含磁盘 path，避免暴露服务端布局） */
export interface DerivativeMeta {
  kind: string;
  status: DerivativeStatus;
  size: number | null;
  frames: number | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  /** canonical fps（29.97 不被钉成 30；VFR 时为 nominal 值） */
  fps: number | null;
  vfr: boolean | null;
  retry: number;
  error_msg: string | null;
  updated_at: string | null;
}

/** 端点 4 响应：单 kind meta（ready 的 sprite/index 附带 json 载荷） */
export interface DerivativeMetaPayload extends DerivativeMeta {
  payload?: unknown;
}

export const videoDerivatives = {
  /** §4-1 入队派生（幂等：ready 不重转；error 且 retry<2 才重入队）。kinds 缺省 = 全三种 */
  derive: (name: string, kinds?: DerivativeKind[]) =>
    request<DerivativeMeta[]>(`/videos/${encodeURIComponent(name)}/derive`, {
      method: 'POST',
      body: JSON.stringify(kinds && kinds.length > 0 ? { kinds } : {}),
    }),

  /** §4-2 该视频全部派生 meta 数组（轮询进度用；status/fps/frames/duration_ms/size/retry） */
  list: (name: string) =>
    request<DerivativeMeta[]>(`/videos/${encodeURIComponent(name)}/derivatives`),

  /** §4-3 派生文件地址（<video>/<img> src 用；Range 206 由 sendFile 原生提供） */
  fileUrl: (name: string, kind: DerivativeFileKind) =>
    apiUrlWithToken(`/videos/${encodeURIComponent(name)}/derivative/${kind}`),

  /** §4-4 单 kind JSON meta（预载前探活，不暴露列表） */
  meta: (name: string, kind: DerivativeKind) =>
    request<DerivativeMetaPayload>(`/videos/${encodeURIComponent(name)}/derivative/${kind}/meta`),
};
