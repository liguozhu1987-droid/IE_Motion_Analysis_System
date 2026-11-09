/**
 * 视频上传统一入口（SPEC-VID-P0 §7.1 分片契约，前后端并行开发的唯一对齐点）：
 *  - 文件 ≤8MB 走现有单文件直传（api.videos.uploadWithProgress：XHR 带进度 + 401 刷新重放）；
 *  - 文件 >8MB 走分片模式（规避 IIS maxAllowedContentLength 默认 28.6MB 的 413 拦截）：
 *      POST /api/videos/upload?uploadId=<uuid>&chunkIndex=<0-based>&chunkTotal=<N>
 *      multipart 字段名 'file'；chunkIndex=0 附带表单字段 originalname / raw；
 *      顺序上传（P0 不做并行/断点续传）；非末片响应 { received, total } 须校验；
 *      末片响应 = 与单文件上传完全同型的 ingest 结果（{ url, name, probe, transcoded }）。
 * 服务端落盘 storage/videos/tmp/chunks/<uploadId>/<i>.part，同 index 重传覆盖（天然幂等）。
 */
import { api, BASE, getAccessToken, refreshTokens, type VideoIngestResult } from '../api';

/** 分片大小上限（契约锁定 ≤8MB） */
const CHUNK_BYTES = 8 * 1024 * 1024;
/** 直传阈值（契约：文件 ≤8MB 走现有单文件直传） */
const DIRECT_MAX_BYTES = 8 * 1024 * 1024;

export interface UploadVideoOptions {
  /** 总进度回调（0-100；直传与分片统一口径） */
  onProgress?: (pct: number) => void;
  /** raw=1：调用方已 canPlayType 确认浏览器能播原始编码（分片模式下随 chunk0 表单字段传递） */
  raw?: boolean;
}

/** 分片中间响应（SPEC-VID-P0 §7.1：非末片 { received, total }；末片 = ingest 结果） */
export interface ChunkAck {
  received: number;
  total: number;
}

/**
 * uploadId 生成：安全上下文（https / localhost）用 crypto.randomUUID；
 * 现场域 http://ap.inalfa.local 属非 potentially trustworthy origin，randomUUID 不可用 →
 * getRandomValues（无安全上下文限制）手拼 v4。后端白名单 /^[0-9a-zA-Z-]{8,64}$/ 兼容。
 */
function newUploadId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 单分片 XHR 上传（与 api.videos.uploadWithProgress 同款 401 单次刷新重放；onProgress 传本片已传字节） */
function sendChunk(url: string, fd: FormData, onBytes?: (loaded: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    let retried = false;
    const send = () => {
      xhr.setRequestHeader('Authorization', 'Bearer ' + (getAccessToken() ?? ''));
      if (onBytes && xhr.upload) {
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onBytes(e.loaded); };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText) as unknown); }
          catch { reject(new Error('上传响应解析失败')); }
        } else if (xhr.status === 401 && !retried) {
          retried = true; // 只重放一次，避免刷新失败时死循环
          void refreshTokens().then((ok) => (ok ? send() : reject(new Error('登录已过期，请刷新页面重试'))));
        } else {
          let msg = `上传失败（HTTP ${xhr.status}）`;
          try {
            const j = JSON.parse(xhr.responseText) as { detail?: string; title?: string; message?: string };
            msg = (j && (j.detail || j.title || j.message)) || msg;
          } catch { /* 非 JSON 保留状态码信息 */ }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误：上传中断（请检查与服务器的连接）'));
      xhr.send(fd);
    };
    send();
  });
}

/** 分片上传（顺序；非末片校验 {received,total}，末片返回 ingest 结果） */
async function uploadChunked(file: File, opts: UploadVideoOptions): Promise<VideoIngestResult> {
  const uploadId = newUploadId();
  const chunkTotal = Math.max(1, Math.ceil(file.size / CHUNK_BYTES));
  for (let i = 0; i < chunkTotal; i += 1) {
    const start = i * CHUNK_BYTES;
    const end = Math.min(start + CHUNK_BYTES, file.size);
    const fd = new FormData();
    fd.append('file', file.slice(start, end));
    if (i === 0) {
      // 契约：chunkIndex=0 附带 originalname / raw（服务端落 meta.json，末片合并时读取）
      fd.append('originalname', file.name);
      if (opts.raw) fd.append('raw', '1');
    }
    const qs = `uploadId=${encodeURIComponent(uploadId)}&chunkIndex=${i}&chunkTotal=${chunkTotal}`;
    // 进度按字节口径：start（前序片合计字节）+ 本片已传字节
    const res = await sendChunk(`${BASE}/videos/upload?${qs}`, fd, (loaded) => {
      opts.onProgress?.(Math.min(99, Math.round(((start + loaded) / file.size) * 100)));
    });
    if (i < chunkTotal - 1) {
      // 非末片：契约响应 { received, total }——序号错位即中断，防静默错片
      const ack = (res ?? {}) as Partial<ChunkAck>;
      const n = Number(ack.received);
      const t = Number(ack.total);
      if (!Number.isFinite(n) || !Number.isFinite(t) || n !== i + 1 || t !== chunkTotal) {
        throw new Error(`分片 ${i + 1}/${chunkTotal} 响应异常（received=${String(ack.received)}），上传已中断`);
      }
      continue;
    }
    // 末片：与单文件上传完全同型的 ingest 结果
    const out = res as VideoIngestResult;
    if (!out || typeof out.name !== 'string' || typeof out.url !== 'string') {
      throw new Error('分片合并响应异常：缺少 url / name，请重试');
    }
    opts.onProgress?.(100);
    return out;
  }
  throw new Error('分片上传未执行（chunkTotal 异常）');
}

/** 上传视频（统一入口：按大小自动选择直传 / 分片），返回可直接播放的 ingest 结果 */
export async function uploadVideo(file: File, opts: UploadVideoOptions = {}): Promise<VideoIngestResult> {
  if (file.size <= DIRECT_MAX_BYTES) return api.videos.uploadWithProgress(file, opts.onProgress, opts.raw ?? false);
  return uploadChunked(file, opts);
}
