/**
 * useVideoEngine —— <video> 帧步进吸附引擎（SPEC-VID-P0 §6，轨A）。
 * 背景（ADR-VID-001）：普通 GOP=250 下 seek 会落到之前最近关键帧再解到目标帧，
 * currentTime 被吸附到关键帧时刻；服务端 all-intra 分析代理（g=1）是逐帧精确的硬前提。
 *  - stepFrame：f = Math.round(currentTime*fps) + dir; currentTime = f/fps（帧网格精确落帧）；
 *  - seekToFrame：currentTime = n / fps；
 *  - snapToFrameGrid：代理视频吸附最近 1/fps（吸收浏览器浮点吸附误差）；
 *    非代理视频吸附最近 keyframeList 项（P0 无关键帧清单来源时退化为 1/fps 网格 = 现状吸附）；
 *  - 负 playbackRate 倒放 Chrome 抛 NotSupportedError，P0 不做（由调用方定时器步进模拟）。
 */
import { useCallback, useRef, useState } from 'react';

/** 引擎配置（fps 以服务端 index meta 的 canonical fps 优先，前端 rVFC 采样为交叉校验兜底） */
export interface VideoEngineConfig {
  /** 帧率（>0；非法值回落 30） */
  fps: number;
  /** 当前是否使用分析代理 URL（决定 snapToFrameGrid 的吸附基准） */
  proxyActive?: boolean;
  /** 非代理视频的关键帧时刻清单（秒；P0 缺省为空 → 退化 1/fps 网格） */
  keyframeList?: number[];
}

export interface VideoEngine {
  /** 引擎是否已绑定 video 元素（src 就绪） */
  ready: boolean;
  /** 绑定 video 元素与配置（视频载入/切源/帧率变化时调用） */
  load: (videoEl: HTMLVideoElement | null, cfg: VideoEngineConfig) => void;
  /** 逐帧步进（dir=-1 后退 / +1 前进；帧网格精确） */
  stepFrame: (dir: -1 | 1) => void;
  /** 定位到第 n 帧 */
  seekToFrame: (frame: number) => void;
  /** 把 currentTime 吸附到帧网格（代理=1/fps；非代理=最近关键帧） */
  snapToFrameGrid: () => void;
  /** 当前帧号（round(currentTime × fps)） */
  currentFrame: () => number;
}

/** 帧网格吸附：round(t × fps) / fps */
const snapTo = (t: number, fps: number) => Math.round(t * fps) / fps;

/** 关键帧清单里最近的一项（秒） */
const nearestKeyframe = (t: number, list: number[]) =>
  list.reduce((best, k) => (Math.abs(k - t) < Math.abs(best - t) ? k : best), list[0]);

export function useVideoEngine(): VideoEngine {
  const elRef = useRef<HTMLVideoElement | null>(null);
  const cfgRef = useRef<VideoEngineConfig>({ fps: 30, proxyActive: false, keyframeList: [] });
  const [ready, setReady] = useState(false);

  const load = useCallback((videoEl: HTMLVideoElement | null, cfg: VideoEngineConfig) => {
    elRef.current = videoEl;
    cfgRef.current = {
      fps: cfg.fps > 0 && Number.isFinite(cfg.fps) ? cfg.fps : 30,
      proxyActive: cfg.proxyActive ?? false,
      keyframeList: cfg.keyframeList ?? [],
    };
    setReady(Boolean(videoEl));
  }, []);

  /** 时间裁剪到合法区间（duration 未知时不设上界；负值归零） */
  const clampTime = (t: number): number => {
    const v = elRef.current;
    const dur = v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    return Math.max(0, dur > 0 ? Math.min(t, dur) : t);
  };

  const stepFrame = useCallback((dir: -1 | 1) => {
    const v = elRef.current;
    if (!v) return;
    const f = Math.round(v.currentTime * cfgRef.current.fps) + dir;
    v.currentTime = clampTime(f / cfgRef.current.fps);
  }, []);

  const seekToFrame = useCallback((frame: number) => {
    const v = elRef.current;
    if (!v || !Number.isFinite(frame)) return;
    v.currentTime = clampTime(frame / cfgRef.current.fps);
  }, []);

  const snapToFrameGrid = useCallback(() => {
    const v = elRef.current;
    if (!v) return;
    const { fps, proxyActive, keyframeList = [] } = cfgRef.current;
    if (!proxyActive && keyframeList.length > 0) {
      v.currentTime = clampTime(nearestKeyframe(v.currentTime, keyframeList));
      return;
    }
    // 代理（all-intra，逐帧精确）或无关键帧清单：吸附最近 1/fps，吸收浏览器浮点误差
    v.currentTime = clampTime(snapTo(v.currentTime, fps));
  }, []);

  const currentFrame = useCallback(() => {
    const v = elRef.current;
    return v ? Math.round(v.currentTime * cfgRef.current.fps) : 0;
  }, []);

  return { ready, load, stepFrame, seekToFrame, snapToFrameGrid, currentFrame };
}
