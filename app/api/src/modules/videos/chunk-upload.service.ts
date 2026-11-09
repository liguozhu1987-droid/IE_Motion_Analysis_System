import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { VideosService, VideoHandle } from './videos.service';

/** 分片参数（SPEC-VID-P0 §7.1 契约锁定） */
export interface ChunkParams {
  /** 分片会话 uuid（前端生成） */
  uploadId: string;
  /** 0-based 分片序号 */
  chunkIndex: number;
  /** 总片数 */
  chunkTotal: number;
}

/** chunkIndex=0 附带的表单字段（沿用单文件上传语义） */
export interface ChunkMeta0 {
  originalname?: string;
  raw?: string;
}

type Owner = { userId: string; username: string; tenantId: string };

/**
 * 分片上传（SPEC-VID-P0 §7.1，契约已锁定——前后端并行开发的唯一对齐点）：
 *  - 落盘 storage/videos/tmp/chunks/<uploadId>/<chunkIndex>.part，同 index 重传覆盖（天然幂等）；
 *  - temp+concat 策略：收到末片且 0..N-1 齐全 → 顺序合并 → 复用现有 ingest() → 清理分片目录；
 *  - chunkIndex=0 的 originalname/raw 表单字段落 meta.json，末片合并时读取；
 *  - 非末片返回 { received, total }，末片返回与单文件上传完全相同的 ingest 结果；
 *  - 权限 element:write 由 controller 装饰器保证（同现有）。
 */
@Injectable()
export class ChunkUploadService {
  private readonly log = new Logger('ChunkUpload');
  private readonly chunkRoot = path.resolve(process.cwd(), 'storage', 'videos', 'tmp', 'chunks');

  constructor(private readonly videos: VideosService) {}

  async handle(
    file: { path: string; size: number },
    p: ChunkParams,
    meta0: ChunkMeta0 | undefined,
    owner?: Owner,
  ): Promise<{ received: number; total: number } | VideoHandle> {
    // 参数白名单校验：uploadId 限字符集防目录穿越，序号须为合法区间整数
    if (!/^[0-9a-zA-Z-]{8,64}$/.test(p.uploadId)) throw new BadRequestException('非法 uploadId');
    if (!Number.isInteger(p.chunkIndex) || !Number.isInteger(p.chunkTotal)
      || p.chunkTotal < 1 || p.chunkIndex < 0 || p.chunkIndex >= p.chunkTotal) {
      throw new BadRequestException('非法分片序号（chunkIndex 须为 0..chunkTotal-1）');
    }
    const dir = path.join(this.chunkRoot, p.uploadId);
    fs.mkdirSync(dir, { recursive: true });
    // chunkIndex=0 携带 originalname/raw → 落 meta.json（末片请求时读取；重传 chunk0 时覆盖）
    if (p.chunkIndex === 0) {
      const meta = {
        originalname: typeof meta0?.originalname === 'string' ? meta0.originalname.slice(0, 200) : '',
        raw: meta0?.raw === '1' ? '1' : '',
      };
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
    }
    // 同 index 重传覆盖（rename 在 Windows 上覆盖已存在目标）
    fs.renameSync(file.path, path.join(dir, `${p.chunkIndex}.part`));
    if (p.chunkIndex !== p.chunkTotal - 1) {
      return { received: p.chunkIndex + 1, total: p.chunkTotal };
    }
    // 末片：0..N-1 齐全才合并（缺失明确报序号，前端可只补传缺口）
    const missing: number[] = [];
    for (let i = 0; i < p.chunkTotal; i++) {
      if (!fs.existsSync(path.join(dir, `${i}.part`))) missing.push(i);
    }
    if (missing.length > 0) throw new BadRequestException(`分片不完整，缺失序号：${missing.join(',')}`);
    let meta: { originalname?: string; raw?: string } = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    } catch {
      // chunk0 未带 meta（异常客户端）：按 mp4 兜底，ingest 探测仍会给出真实容器
    }
    const ext = (path.extname(meta.originalname || '') || '.mp4').toLowerCase().slice(0, 8);
    const tmpDir = path.resolve(process.cwd(), 'storage', 'videos', 'tmp');
    const merged = path.join(tmpDir, `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    // 顺序合并（P0 串行上传；temp+concat 天然支持后续并行/乱序/续传演进，契约参数不变）
    const out = fs.openSync(merged, 'w');
    try {
      for (let i = 0; i < p.chunkTotal; i++) {
        fs.writeSync(out, fs.readFileSync(path.join(dir, `${i}.part`)));
      }
    } finally {
      fs.closeSync(out);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    const originalName = meta.originalname && meta.originalname.length > 0
      ? meta.originalname : `chunk_${p.uploadId}${ext}`;
    this.log.log(`分片合并完成: ${originalName} (${p.chunkTotal} 片) → ${path.basename(merged)}`);
    // 末片响应 = 与单文件上传完全相同（复用 ingest：探测/转码/直通/归属登记）
    try {
      return await this.videos.ingest(merged, originalName, meta.raw === '1', owner);
    } catch (e) {
      try { fs.unlinkSync(merged); } catch { /* 已删 */ }
      throw e;
    }
  }
}
