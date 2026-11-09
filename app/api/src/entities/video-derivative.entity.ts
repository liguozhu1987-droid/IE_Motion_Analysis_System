import { Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * 视频派生物（SPEC-VID-P0 §3，ADR-VID-001 决策 4）。
 *
 * 服务端 ffmpeg 派生层的状态表：分析代理（all-intra）/ 精灵图 / 帧索引，
 * 懒生成 + 队列消费。幂等由唯一键 (file_name, kind) 保证——
 * 重复 derive 请求不重转（status=ready 直接返回；status=error 且 retry<2 才重入队）。
 *
 * 状态机：pending → running → ready(填 meta) / error(retry+1，retry<2 下轮自动重入)；
 * P0.5 磁盘治理另有 ready → evicted（LRU 删代理保源视频，再次访问时 derive 重置为 pending）。
 * 不加 FK：源视频是 storage 目录里的裸文件（uuid.mp4），t_video_asset 也只是归属登记，
 * 派生行随源文件物理删除而成为孤儿——P0-1 起由 worker 的孤儿巡检兜底
 * （VIDEO_ORPHAN_SWEEP=1 才开，默认关，防共享存储瞬时不可见时误删）。
 *
 * DDL 见 scripts/migrate.ts（生产 mssql 幂等建表；开发 sqlite 由 synchronize 自动建表）。
 */
@Entity({ name: 't_video_derivative' })
@Index('UQ_video_derivative_file_kind', ['file_name', 'kind'], { unique: true })
export class VideoDerivative {
  /** 行 uuid */
  @PrimaryColumn({ length: 36 }) id: string;
  /** 源视频文件名（uuid.mp4，对应 t_video_asset.file_name） */
  @Column({ length: 64 }) file_name: string;
  /** proxy | sprite | index */
  @Column({ length: 16 }) kind: string;
  /** pending | running | ready | error | evicted */
  @Column({ length: 16, default: 'pending' }) status: string;
  /** 派生文件磁盘路径（ready 后回填） */
  @Column({ length: 512, nullable: true }) path: string | null;
  /** 派生文件字节数（mssql bigint，读取时须 Number() 归一） */
  @Column({ type: 'bigint', nullable: true }) size: number | null;
  /** 帧数（CFR=按 fps 换算；VFR=entries 实数；sprite=缩略图张数） */
  @Column({ type: 'int', nullable: true }) frames: number | null;
  @Column({ type: 'int', nullable: true }) duration_ms: number | null;
  @Column({ type: 'int', nullable: true }) width: number | null;
  @Column({ type: 'int', nullable: true }) height: number | null;
  /** canonical fps（29.97 不得硬钉成 30；前端 rVFC 仅作交叉校验） */
  @Column({ type: 'real', nullable: true }) fps: number | null;
  /** 1=可变帧率，前端须用 index.json 的逐帧 entries 换算。
   *  不写死 type——交给 TypeORM 按方言推断：mssql→BIT（与 migrate.ts 的 `vfr BIT NULL` 一致），
   *  sqlite→BOOLEAN（隔离测试用）。此前写 `type:'boolean'`，mssql 驱动不认该类型名，
   *  导致整个 DataSource 建不起来、API 启动即崩；而隔离测试走 sqlite 能过 → 漏网。 */
  @Column({ nullable: true }) vfr: boolean | null;
  /** 失败重试计数（error 且 retry<2 时下轮自动重入） */
  @Column({ type: 'smallint', default: 0 }) retry: number;
  /** LRU 预留列（P0 不写入，P0.5 磁盘告警/LRU 删代理时启用，无迁移） */
  @Column({ type: 'datetime', nullable: true }) last_accessed_at: Date | null;
  @Column({ length: 512, nullable: true }) error_msg: string | null;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
