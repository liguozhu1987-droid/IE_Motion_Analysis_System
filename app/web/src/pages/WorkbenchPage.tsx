import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, videoFileUrl, AUTH_REFRESHED_EVENT, type Element, type Station, type StationVersion, type ValidationIssue } from '../api';
import { videoDerivatives, type DerivativeMeta } from '../video/derivatives';
import { uploadVideo } from '../video/chunkedUpload';
import { useVideoEngine } from '../video/useVideoEngine';
import { useAuth } from '../auth';
import { HAND_LABEL, PX_PER_SEC, THERBLIG_GROUPS, TYPE_DEFAULTS, VA_CLASS_LABEL, stdTime, today } from '../constants';
import { BODY_REACH, BODY_REACH_TYPES, buildPreview, motionFormatHint, parseDescToFields, parseFormat, useMotionStandard, type MotionEntry } from '../motionStandard';
import { carryLevel, extractObject, isNewCycleBreak, objectFieldName } from '../actionCarryover';
import TypeSelect from '../components/TypeSelect';
import AutoBanner from '../components/AutoBanner';
import AiCallBanner from '../components/AiCallBanner';
import Toolbox, { type ToolAction } from '../components/Toolbox';
import { matchFieldOption } from '../typeFreq';

interface Draft {
  key: string;
  seq: number;
  start_ms: number;
  dur_s: number;
  hand: 'L' | 'R' | 'B';
  type: string;
  desc: string;
  va_class: string;
  va_reason: string;
  outlier_flag: number;
  outlier_reason: string;
  rating: number;
  allowance: number;
  /**
   * v3.47 双线隔离：要素来源。AI 自动分解写入的要素为 'ai_assisted'，
   * 回写时必须原样带回（治"AI 成果被手工线提交静默降级为 manual"的 P0）。
   */
  source?: 'manual' | 'ai_assisted';
  /**
   * 评定来源（工时专家会审 P0-1：根治"全默认到底"的虚假精确 ST）。
   * undefined=未评定（用默认 1.00/0.15 计算，界面显"未评定"）；'batch'=批量评定覆盖；'hand'=逐要素手工评定。
   * 库中已提交要素视为 'hand'（入库值即显式评定值）；新建/复用（不复制评比）要素为 undefined。
   */
  rated?: 'batch' | 'hand';
}

interface Loaded {
  station: Station;
  elements: Element[];
  versions: StationVersion[];
}

/**
 * v3.29 时间量纲统一（"要素时间重叠"误报修复，根因见 deliverables/v329）：
 * 数据库口径 = start_ms 为 INT（整数毫秒）+ dur_s 为 DECIMAL(10,2)（10ms 网格）。
 * 旧实现在若干入口产生**分数起点**（K 停/分割/拖拽磁吸的帧量化播放头，33.33ms 步进）
 * 与 **3 位小数时长**（I/O 未取整），与"自动链按未取整值链接起点 + 落库按 round2 截断"
 * 叠加，产生 1~5ms 幻影"时间重叠"（后端 V2 误报）。修复口径（三恒等）：
 *  ① 所有边界标记一律取整到整数毫秒（与 INT 列一致）；
 *  ② 所有时长一律量化到 10ms 网格（与 DECIMAL(10,2) 一致）；
 *  ③ 要素止点恒等于后端 V2 公式 start_ms + round(dur_s×1000)，
 *     自动链起点与落库止点逐毫秒一致——幻影重叠从根上消除，真重叠仍如实拦截。
 */
/** 时长（秒）量化到 10ms 网格（2 位小数）——与 t_element.dur_s 存储精度一致 */
const durToGrid = (s: number) => Math.round(s * 100) / 100;
/** 要素止点（ms）= 后端 V2 校验同公式：start_ms + round(量化后 dur_s × 1000)，恒为整数 */
const elEndMs = (d: { start_ms: number; dur_s: number }) =>
  Math.round(d.start_ms + durToGrid(d.dur_s) * 1000);

/**
 * v3.28 可选视频格式：浏览器能直播的（MP4/H.264、MOV/H.264、WebM/VP8/VP9/AV1）本地直载；
 * 不能直播的（AVI、MKV、FLV、WMV、TS、HEVC、RMVB 等）由工作台自动上传后端 ffmpeg 转码为 MP4 后播放。
 * mime + 扩展名双写：rmvb 等无标准 mime 的格式靠扩展名命中。
 */
const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/x-matroska,video/avi,video/x-msvideo,video/x-flv,'
  + 'video/webm,video/x-ms-wmv,video/mp2t,'
  + '.mp4,.mov,.m4v,.mkv,.avi,.flv,.webm,.wmv,.ts,.mts,.m2ts,.3gp,.rmvb';

/* 传输条图标（内联 SVG：与文字同色、随字号缩放） */
const IconPlay = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M8 5.2 19 12 8 18.8z" fill="currentColor" /></svg>
);
const IconPause = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" />
  </svg>
);
const IconPrevFrame = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M18 5.2 8.5 12 18 18.8z" fill="currentColor" /><rect x="5" y="5" width="1.8" height="14" rx="0.9" fill="currentColor" />
  </svg>
);
const IconNextFrame = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M6 5.2 15.5 12 6 18.8z" fill="currentColor" /><rect x="17.2" y="5" width="1.8" height="14" rx="0.9" fill="currentColor" />
  </svg>
);
const IconTrash = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const IconSplit = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <circle cx="6.5" cy="17.5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <circle cx="6.5" cy="6.5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M9 8.4 20 17M9 15.6 20 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
/** P0-1 图标纪律：emoji 禁作功能图标——顶栏工具箱按钮用统一描边 SVG（16px 内联级） */
const IconToolbox = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <rect x="3" y="8" width="18" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M9 8V6.5A2.5 2.5 0 0 1 11.5 4h1A2.5 2.5 0 0 1 15 6.5V8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M3 13h18" stroke="currentColor" strokeWidth="1.8" />
    <path d="M10.5 13v2.6h3V13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  </svg>
);
/** 清单「缺对象」徽标（红色警示三角，统一描边，随字号缩放） */
const IconWarnTri = () => (
  <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" style={{ verticalAlign: '-1px' }}>
    <path d="M12 3.5 22 20H2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M12 10v4.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <circle cx="12" cy="17.2" r="0.6" fill="currentColor" />
  </svg>
);

/** 时间码：mm:ss.mmm（毫秒级——帧进步长 16.7/33.4ms 才能被分辨） */
const fmtTime = (ms: number) => {
  const total = Math.max(0, Math.round(ms)) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
};

/** 时间码（时:分:秒.毫秒）：hh:mm:ss.mmm，如 00:04:16.056——清单起点/止点列用（含小时位，便于长视频定位） */
const fmtTimecode = (ms: number) => {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const msPart = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(msPart).padStart(3, '0')}`;
};

/** 描述是否退化为「纯动词」（去 VA 标记、去空白后 = 类型动词本身，无对象/位置等实质内容）。
 *  与后端 validation.ts 的 isBareVerb 同口径——「漏填作业内容」的精确信号。 */
const isBareVerbDesc = (type: string, desc: string) =>
  (desc ?? '').replace(/\[VA(改判|确认)\|[^\]]*\]/g, '').replace(/\s+/g, '') === type.replace(/\s+/g, '');

/**
 * 时间码解析（v3.57 起/止点字段用）：把「03:45.021 / 03:45 / 纯毫秒数字」解析回毫秒。
 * 返回 null = 非法输入（调用方保留原值并提示）。
 */
const parseTimecode = (text: string): number | null => {
  const t = String(text ?? '').trim();
  if (t === '') return null;
  // 纯数字 → 当作毫秒（兼容旧输入习惯）
  if (/^\d+(\.\d+)?$/.test(t)) {
    const ms = Number(t);
    return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
  }
  // mm:ss.mmm / mm:ss / hh:mm:ss.mmm
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(t);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  const msPart = m[4] ? Number(m[4].padEnd(3, '0')) : 0;
  if (ss >= 60 || mm >= 60) return null;
  return ((h * 60 + mm) * 60 + ss) * 1000 + msPart;
};

/** 起/止点时间码输入字段（受控文本：聚焦可自由编辑 mm:ss.mmm，失焦/回车解析回毫秒）。 */
function TimecodeField({ label, value, onCommit, disabled }: {
  label: string; value: number; onCommit: (ms: number) => void; disabled?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  // 外部值变化（非编辑中）→ 刷新文本
  const editing = text !== null;
  const shown = editing ? text : fmtTime(value);
  return (
    <label className="wb-field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        className="mono"
        disabled={disabled}
        value={shown}
        title="时间码 mm:ss.mmm（如 03:45.021），也可直接输入毫秒数字"
        onFocus={() => setText(fmtTime(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const parsed = text === null ? null : parseTimecode(text);
          setText(null);
          if (parsed !== null) onCommit(parsed);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setText(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

/**
 * 分解工作台（v3.5 · 精密分解台）。
 * 单屏工作室布局：深色监看区（视频+传输条+记录动作）｜属性检查器（可滚动常驻）｜工作区（时间线/清单页签）｜粘底交付条。
 * 快捷键只在 ? 帮助浮层中展示，界面控件仅保留 title 提示（不占版面）；关键指标本地即时计算，减少跨页查看。
 */
export default function WorkbenchPage({ stationId }: { stationId: string }) {
  const { can } = useAuth();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationIssue[]>([]);
  const [busy, setBusy] = useState(false);
  /** v3.45 手工分解线「AI自动识别浪费」：进行态 + 结果链接（toast 内「前往浪费识别 →」） */
  const [wasteBusy, setWasteBusy] = useState(false);
  const [wasteLink, setWasteLink] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  /** SPEC-VID-P0：服务端视频文件名（uuid.mp4；本地 object URL 时为 null）——派生轮询的键 */
  const [serverName, setServerName] = useState<string | null>(null);
  /** 分析代理是否已就绪并接管 src（all-intra，J/L 逐帧精确；未就绪回退原始 file/:name） */
  const [proxyActive, setProxyActive] = useState(false);
  /** 上传进度 0-100（直传/分片统一口径；转码浮层展示，>8MB 大文件不再干等） */
  const [uploadPct, setUploadPct] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showHelp, setShowHelp] = useState(false);
  const [panelTab, setPanelTab] = useState<'timeline' | 'list'>('timeline');
  /* 时间线条默认展开：与属性检查器同屏并存（填属性、拖边界互不遮挡）；要更大画面时一键收起 */
  const [tlOpen, setTlOpen] = useState(true);
  /** 短暂提示（"已记录 #3 …"），2 秒后自动消失 */
  const [flash, setFlash] = useState<string | null>(null);
  /** 结构化描述草稿（跨要素保留：流水线重复动作只改差异字段）。
   *  字段集合由所选类型的「描述格式」动态决定（动作标准 MS：拿取=对象/于/位置/距离；目检=对象/属性…） */
  const [sdValues, setSdValues] = useState<Record<string, string>>({});
  /** 动作行程（部位档：手指/手腕/小臂/大臂/肩，对应动作等级 1~5——视频场景的主力行程标识） */
  const [sdReach, setSdReach] = useState('');
  /**
   * 对象继承「请确认」标注（v3.26，IE 专家团三级预填策略第 2 级）：
   * conditional 级（检查后 NG 返工/设备边界/工具耗材/拆包装续作）预填对象后挂此提示，
   * 与选中要素 key 绑定（换要素自动失效）；用户改写对象字段即视为已确认、清除提示。
   */
  const [carryHint, setCarryHint] = useState<{ key: string; msg: string } | null>(null);
  /** 片段播放预卷：起点前 0.4s 起播，留出动作准备过程的观察余量 */
  const PREROLL_MS = 400;
  /** 片段循环开关（v3.22）：默认**单次**——播到止点即停（分解主路径是"播一遍看边界"）；
   *  核对边界反复看时再开循环。开关布置在倍率按钮同一行。 */
  const [segLoop, setSegLoop] = useState(false);
  const segLoopRef = useRef(false);
  useEffect(() => { segLoopRef.current = segLoop; }, [segLoop]);
  /** 手别延续（用户反馈）：新要素默认"双手"，选定 L/R 后后续要素沿用，省去逐要素点选 */
  const [handMemo, setHandMemo] = useState<'L' | 'R' | 'B'>('B');
  /** 片段播放：选中要素后播放仅限其起止范围（循环），用于单动作边界核对；取消选中即恢复全片 */
  const segEndRef = useRef<number | null>(null);
  /** 单次片段已自然播完；不能靠 currentTime 推断，它可能滞后于已呈现帧。 */
  const segFinishedRef = useRef(false);
  const selRef = useRef<Draft | null>(null);
  /** 快捷工具箱（v3.20，Ctrl+K）：命令面板式可调用工具箱，业务逻辑全部复用既有 handler */
  const [toolboxOpen, setToolboxOpen] = useState(false);
  /** 删除撤销（单级）：保留被删要素与原始位置 8 秒 */
  const [lastDeleted, setLastDeleted] = useState<{ item: Draft; index: number } | null>(null);
  const [showReuse, setShowReuse] = useState(false);
  /** 使时间段连续：右键时间线片段后弹出，记录目标片段 + 鼠标坐标（null=关闭）。对齐其起点到相邻上一片段止点 */
  const [contiguousTarget, setContiguousTarget] = useState<{ el: Draft; x: number; y: number } | null>(null);
  /** 复用来源：同线其他工位（有要素的） */
  const [siblings, setSiblings] = useState<{ station_id: string; name: string; element_count: number }[]>([]);
  const [reuseMode, setReuseMode] = useState<'append' | 'replace'>('append');
  /** 复用是否连带评比/宽放（默认不连带——防跨工位 ST 虚假一致，复用后须按本工位重新评定） */
  const [reuseCopyRating, setReuseCopyRating] = useState(false);
  const [reuseBusy, setReuseBusy] = useState(false);
  /* ---- 批量评定（工时专家会审 P0-1：按"操作者×循环"集中评定，根治逐要素全默认到底）---- */
  const [showBatch, setShowBatch] = useState(false);
  const [batchRating, setBatchRating] = useState(1.0);
  const [batchAllowance, setBatchAllowance] = useState(0.15);
  /** 应用范围：unrated=只填没动过的（默认，零风险）；all=全部要素 */
  const [batchScope, setBatchScope] = useState<'unrated' | 'all'>('unrated');
  /** 西屋法四因子简化五档（代数和+1.0）；宽放四档（生理+疲劳+事务合并） */
  const RATING_TIERS: { v: number; label: string; hint: string }[] = [
    { v: 0.85, label: '明显偏慢', hint: '动作迟疑、找料、来回确认，节奏明显拖' },
    { v: 0.90, label: '略慢', hint: '比正常慢一点，动作连续不发慌' },
    { v: 1.00, label: '正常', hint: '合格操作工的自然节奏，能维持一整天' },
    { v: 1.05, label: '偏快', hint: '熟练流畅，明显比常人快，方法没变' },
    { v: 1.10, label: '显著快', hint: '老手级；再快要查是不是方法/治具不同——那是改善点，不是系数' },
  ];
  const ALLOWANCE_TIERS: { v: number; label: string; hint: string }[] = [
    { v: 0.10, label: '轻', hint: '坐姿轻手工、负荷小、环境正常' },
    { v: 0.15, label: '中', hint: '常规装配、少量搬运，多数工位在这档' },
    { v: 0.20, label: '重', hint: '常搬 5~15kg，或站姿为主、间歇用力' },
    { v: 0.25, label: '特重', hint: '大件重搬、高温噪音环境，需本厂抽样复核' },
  ];
  const unratedCount = draft.filter((d) => !d.rated).length;
  const batchCount = draft.filter((d) => d.rated === 'batch').length;
  const handRatedCount = draft.filter((d) => d.rated === 'hand').length;
  /** 范围=全部且将命中手工评定值 → 面板内联警示（不弹窗） */
  const batchOverwrite = batchScope === 'all' && handRatedCount > 0;
  const applyBatch = () => {
    const cover = batchScope === 'all' ? draft : draft.filter((d) => !d.rated);
    if (cover.length === 0) { setFlash('没有可应用的要素'); setTimeout(() => setFlash(null), 2000); return; }
    const covered = new Set(cover.map((d) => d.key));
    setSubmitted(false); // v3.45 草稿脏检查（P1-1）：批量评定改变 ST 口径，复位 submitted
    setDraft((prev) => prev.map((d) => (covered.has(d.key) ? { ...d, rating: batchRating, allowance: batchAllowance, rated: 'batch' as const } : d)));
    setFlash(`已批量评定 ${covered.size} 个要素：${batchRating.toFixed(2)} / ${Math.round(batchAllowance * 100)}%`);
    setTimeout(() => setFlash(null), 2500);
    setShowBatch(false);
  };
  const descRef = useRef<HTMLInputElement>(null);
  /** 帧率是否已校准（每个视频只采一次） */
  const fpsSampled = useRef(false);
  /** 切换视频时重置帧率与采样标记（服务端 canonical fps 已供数时不回落 30，防代理切源后丢帧率） */
  useEffect(() => { fpsSampled.current = false; setFps(serverFpsRef.current ?? 30); }, [videoUrl]);
  const [cycles, setCycles] = useState(15);
  const [cv, setCv] = useState(0.1);
  /**
   * 新片段默认时长（秒，v3.26 用户反馈：连续生成时新片段需有合理默认时长且可按需调整）。
   * 交付参数区可改，localStorage 持久化——分解一个工位期间通常恒定，跨工位沿用。
   */
  const [newDurS, setNewDurS] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('wb-new-dur'));
      return Number.isFinite(v) && v > 0 && v <= 60 ? v : 1;
    } catch { return 1; }
  });
  useEffect(() => { try { localStorage.setItem('wb-new-dur', String(newDurS)); } catch { /* 隐私模式静默 */ } }, [newDurS]);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** 服务端 canonical fps（index 派生 meta 供数；ADR-VID-001 决策 6：服务端优先，rVFC 采样降级为交叉校验） */
  const serverFpsRef = useRef<number | null>(null);
  /**
   * 服务端关键帧清单（P0.5，keyframeList 服务端来源落地）：index.json 载荷的 keyframes
   * （源视频 I 帧时刻 ms，升序）→ 秒数组。非代理视频（代理未就绪回退 / 无派生）的
   * snapToFrameGrid 吸附基准从「1/fps 均匀网格」升级为「最近真实 I 帧」——GOP 吸附不漂移。
   * 代理就绪后不参与吸附（all-intra 逐帧精确），但保留状态不回退。
   */
  const [keyframesSec, setKeyframesSec] = useState<number[]>([]);
  const keyframesRef = useRef<number[]>([]);
  /** 帧步进吸附引擎（SPEC-VID-P0 §6：J 键步进 / L 松开停帧吸附走引擎；K 播放暂停维持现状） */
  const engine = useVideoEngine();
  /**
   * 视频真实帧率（默认 30）。浏览器无法直接读 fps，只能靠 requestVideoFrameCallback
   * 采样相邻帧的 mediaTime 差值取中位数推断，再吸附到常见档位（24/25/29.97/30/50/59.94/60）。
   * 帧进、帧号、拖拽吸附、分割最小长度全部以 frameMs 为准——不再写死 33ms。
   */
  const [fps, setFps] = useState(30);
  const frameMs = 1000 / fps;
  /** 视频原始宽高比（16/9 等）：画面按此比例在监看区内取最大可比尺寸，消除黑边 */
  const [videoAr, setVideoAr] = useState(16 / 9);
  const wbRef = useRef<HTMLDivElement>(null);
  /** 主区（视频舞台 + 检查器）：实测高度反推舞台宽度，让画面不留黑边 */
  const mainRef = useRef<HTMLDivElement>(null);
  /** 监看区屏幕容器（视频画面在此容器内取最大等比帧） */
  const screenRef = useRef<HTMLDivElement>(null);
  /** 舞台宽度（px）：由主区实测高度 × 画面宽高比反推（null = 交给 CSS 兜底） */
  const [stageW, setStageW] = useState<number | null>(null);
  /** 检查器折叠态：收起时视频舞台占满主区宽度，获得最大监看视野 */
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  /** v3.19 版本区展开态（有效版本超过 VER_PAGE 条时先折到最近 N 条，防"一长串版本号"吓人） */
  const [verExpanded, setVerExpanded] = useState(false);
  const VER_PAGE = 8;
  /** 实测适配后的视频帧尺寸（px）：容器内不留黑边的最小 letterbox */
  const [videoBox, setVideoBox] = useState<{ w: number; h: number } | null>(null);
  const [isFull, setIsFull] = useState(false);
  /** 拖拽边界时的磁吸反馈：参考线位置 + 光标旁时间提示（行业惯例：ELAN/Premiere 边缘吸附） */
  const [dragInfo, setDragInfo] = useState<{ snapMs: number | null; x: number; y: number; text: string } | null>(null);
  const lanesRef = useRef<{ [key: string]: HTMLDivElement | null }>({});
  /* ---- v3.49 时间线横向自动跟随（用户需求）：要素片段增多后新增片段被右侧边缘遮挡 ---- */
  /** 时间线横向滚动容器（.timeline-wrap.wb-tl） */
  const tlWrapRef = useRef<HTMLDivElement | null>(null);
  /** 上次观察到的草稿右缘（ms）：load 灌入存量只记基线不滚动，之后仅「增长」才跟随 */
  const tlEdgeRef = useRef(0);
  /** 拖拽进行中：抑制跟随（块在指针下，容器滚动会与 pointermove 形成抖动反馈） */
  const draggingRef = useRef(false);
  /** 右缘已增长但当时无容器可滚（时间线收起/在清单页签）→ 切回时间线时补跟随 */
  const tlPendingRef = useRef(false);
  /** 最新草稿镜像：pointerup 等非渲染时机也能按当前数据计算右缘 */
  const draftRef = useRef<Draft[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * v3.28 格式兼容回退三件套：
   *  - pendingFileRef：当前载入的文件引用——浏览器直播失败（MediaError 3/4）时上传后端转码
   *  - objectUrlRef：本地 object URL（换视频时释放，防累积；服务端视频时为 null）
   *  - serverTriedRef：同一文件只走后端一次（转码失败→明确报错，不循环重试）
   */
  const pendingFileRef = useRef<File | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const serverTriedRef = useRef(false);
  /** 服务端转码中进行态（显示源文件名）：浮层提示，避免用户面对黑屏以为卡死 */
  const [videoConverting, setVideoConverting] = useState<string | null>(null);

  /** 播放速度档位（慢放是精细分解的刚需：0.25x 看快速动作） */
  const SPEED_STEPS = [0.25, 0.5, 0.75, 1] as const;

  const canWrite = can('element:write');
  const canRetest = can('station:retest');

  const load = useCallback(async () => {
    const [station, elementRes, versions] = await Promise.all([
      api.station(stationId),
      api.elements(stationId),
      api.stationVersions(stationId),
    ]);
    setLoaded({ station, elements: elementRes.elements, versions });
    setDraft(elementRes.elements.map((el) => ({
      key: el.element_id,
      seq: el.seq,
      start_ms: el.start_ms,
      dur_s: el.dur_s,
      hand: el.hand as Draft['hand'],
      type: el.type,
      desc: el.desc,
      va_class: el.va_class,
      va_reason: '',
      outlier_flag: el.outlier_flag,
      outlier_reason: el.outlier_reason ?? '',
      rating: el.rating,
      allowance: el.allowance,
      // v3.47：来源原样回灌——AI 要素保持 ai_assisted，避免回写时被后端兜底翻成 manual
      source: el.source,
      // 库中已提交要素：入库值即显式评定值（工时专家会审 P0-1）
      rated: 'hand' as const,
    })));
    /* v3.49 自动跟随基线：存量灌入只记右缘不滚动（否则打开工作台时间线跳到最右端） */
    tlEdgeRef.current = elementRes.elements.reduce((m, el) => Math.max(m, elEndMs(el)), 0);
    setSelected(null);
  }, [stationId]);

  useEffect(() => { load().catch((err) => setError(err.message)); }, [load]);

  const selectedElement = draft.find((d) => d.key === selected) ?? null;

  /**
   * v3.48 草稿脏检查（派生，零额外状态）：与已提交要素逐字段比对。
   * fresh load 后 draft≡committed（不脏）；任何编辑（自动描述/微调/拖拽/增删/复用/批量评定
   * 触及持久字段）即脏。用途：「AI自动识别浪费」按脏置灰——后端只分析**已提交**要素，
   * 脏草稿上跑识别等于基于过期数据（v3.45 门控意图的精确化：原先 `!submitted` 在
   * fresh load 恒真，按钮常灰，用户无处可点——BJFA1/ST010 实测路径之一）。
   */
  const draftDirty = useMemo(() => {
    if (!loaded) return false;
    if (draft.length !== loaded.elements.length) return true;
    const byId = new Map(loaded.elements.map((el) => [el.element_id, el]));
    for (const d of draft) {
      const el = byId.get(d.key);
      if (!el) return true;
      if (d.seq !== el.seq || d.start_ms !== el.start_ms || d.dur_s !== el.dur_s
        || d.hand !== el.hand || d.type !== el.type || d.desc !== el.desc
        || d.va_class !== el.va_class || d.outlier_flag !== el.outlier_flag
        || (d.outlier_reason ?? '') !== (el.outlier_reason ?? '')
        || d.rating !== el.rating || d.allowance !== el.allowance
        || (d.source ?? 'manual') !== (el.source ?? 'manual')) return true;
    }
    return false;
  }, [draft, loaded]);
  /** 可跑浪费识别的前提：当前版本有已提交要素（后端按 station.version 分析已提交数据） */
  const hasCommitted = (loaded?.elements.length ?? 0) > 0;

  /* ---- 公司动作分解标准（motion_standard 规则集，DB 发布版优先、内置兜底）----
     类型下拉按一级分组、二级直选；结构化描述字段由所选类型的描述格式动态生成 */
  const motionStd = useMotionStandard();
  const sdEntry: MotionEntry | null = selectedElement ? (motionStd.byType[selectedElement.type] ?? null) : null;
  const sdFields = sdEntry?.format ? parseFormat(sdEntry.format, selectedElement?.type ?? '') : [];
  /** 动作行程（部位档）：手伸向对象执行的动作才显示（转身/弯腰/走动/等待 等各有自己的行程单位，见字段 kind） */
  const needsBodyReach = Boolean(selectedElement && BODY_REACH_TYPES.has(selectedElement.type));
  /** 类型 → 默认 VA：标准（DB 发布版）优先，内置 TYPE_DEFAULTS 兜底 */
  const typeDefaultOf = (type: string): string => motionStd.byType[type]?.va ?? TYPE_DEFAULTS[type] ?? 'RNVA';

  /* ---- 动作衔接与对象继承（v3.26，IE 专家团映射表落地）----
     新片段/类型变更时：按「上一动作 → 下一动作」判定是否预填上一要素的对象字段。
     判定与数据源都在 actionCarryover.ts；这里只做取数与写入。 */
  /** 时间线上的前一要素（继承预填的来源：新片段拼接在它之后） */
  const prevElementOf = (key: string): Draft | null => {
    const sorted = [...draft].sort((a, b) => a.start_ms - b.start_ms);
    const idx = sorted.findIndex((d) => d.key === key);
    return idx > 0 ? sorted[idx - 1] : null;
  };
  /** 取上一要素的对象值：优先从其描述文本解析（稳定，不依赖用户刚才编辑过谁）；失败回退当前字段草稿 */
  const resolveCarryObject = (prevEl: Draft | null): string | null => {
    if (!prevEl) return null;
    const fields = parseFormat(motionStd.byType[prevEl.type]?.format ?? '', prevEl.type);
    const of = objectFieldName(fields);
    if (!of) return null;
    const single = fields.length <= 1; // 单字段格式（按/压/拆…）：动词后整段即对象
    const parsed = extractObject(prevEl.desc, prevEl.type, single);
    return parsed ?? (sdValues[of] || null);
  };
  /** 按继承级别生成新要素的结构化字段草稿（yes=静默预填；conditional=预填+请确认；no=留空） */
  const carrySdFor = (prevEl: Draft | null, nextType: string): { vals: Record<string, string>; hint: string | null } => {
    if (!prevEl) return { vals: {}, hint: null };
    const lvl = carryLevel(prevEl.type, nextType);
    if (lvl === 'no') return { vals: {}, hint: null };
    const fields = parseFormat(motionStd.byType[nextType]?.format ?? '', nextType);
    const of = objectFieldName(fields);
    if (!of) return { vals: {}, hint: null };
    const obj = resolveCarryObject(prevEl);
    if (!obj) return { vals: {}, hint: null };
    return {
      vals: { [of]: obj },
      hint: lvl === 'conditional'
        ? `请确认对象：已按「${prevEl.type} → ${nextType}」组合动作预填，若已换对象请直接改写`
        : null,
    };
  };

  /** 结构化描述预览：动词=当前类型；字段按描述格式语序（拿取 后横梁 于 料箱 150 / 目检 后横梁 划伤）；行程括号缀尾 */
  const sdPreview = selectedElement
    ? buildPreview(selectedElement.type, sdFields, sdValues, sdReach)
    : '';

  /** 剥离描述尾部的 [VA改判|…] 标记（类型变更后旧标记已失效，避免与 V1 校验冲突） */
  const stripVaMarker = (desc: string) => desc.replace(/\s*\[VA改判[^\]]*\]\s*$/g, '').trim();

  /* ---- 选中要素切换：把已存储的 desc 回填到结构化字段（v3.60 修复）----
     旧逻辑：sdValues 仅在新建/改类型/手动整句录入时设置，切换选中要素时不从 desc 重载，
     导致结构化字段残留上一要素的旧值——界面"看着像填了对象"、实际 desc 仍是裸动词，
     提交被 V1「缺少作业内容」拦截。这里在选中变化时按格式反向解析 desc→字段，
     使编辑器如实反映数据；并建立 lastAutoDescRef 基线，使之后在字段里补对象能写回 desc。
     合成占位值「新要素」由新建/改类型流程负责，不在此解析（避免把"新要素"误填进对象字段）。 */
  const lastAutoDescRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedElement) return;
    const d = selectedElement.desc;
    if (d === '新要素') { setCarryHint(null); return; }
    const { values, reach } = parseDescToFields(sdEntry?.format ?? null, selectedElement.type, d);
    setSdValues(values);
    setSdReach(reach);
    setCarryHint(null);
    lastAutoDescRef.current = buildPreview(selectedElement.type, sdFields, values, reach);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedElement?.key]);

  /** 结构化描述自动写入（用户反馈：免点按钮）。只覆盖三种"机器可写"状态：
      空 / 默认"新要素" / 上次结构化草稿生成的文本——人工改过的描述与改判标记永远优先 */
  useEffect(() => {
    if (!selectedElement || !sdPreview) return;
    const d = selectedElement.desc;
    const writable = d === '' || d === '新要素' || (lastAutoDescRef.current != null && d === lastAutoDescRef.current);
    if (writable && d !== sdPreview && !d.includes('[VA改判')) {
      update(selectedElement.key, { desc: sdPreview });
    }
    if (writable) lastAutoDescRef.current = sdPreview;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdValues, sdReach, selectedElement?.type, selectedElement?.key]);

  const update = (key: string, patch: Partial<Draft>) => {
    setDraft((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
    /* v3.45 草稿脏检查（P1-1，设计 D3 直接置位）：任何字段编辑（含自动描述/微调/拖拽）
       令 submitted 复位——「AI自动识别浪费」按钮与「查看分析结果 →」链接同步置灰/隐藏，
       避免基于过期提交态跑识别。submit 成功只走 load() 的 setDraft（不经本函数），不会误触。 */
    setSubmitted(false);
  };

  /** 本地即时指标（要素/CT/VA 结构/异常）：免去为看基础数据而跳转分析页 */
  const stats = useMemo(() => {
    let ct = 0; let va = 0; let rnva = 0; let nva = 0; let outliers = 0;
    for (const d of draft) {
      if (d.outlier_flag === 1) { outliers += 1; continue; }
      const st = stdTime(d.dur_s, d.rating, d.allowance);
      ct += st;
      if (d.va_class === 'VA') va += st;
      else if (d.va_class === 'RNVA') rnva += st;
      else nva += st;
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      ct: r2(ct), va: r2(va), rnva: r2(rnva), nva: r2(nva), outliers,
      vaPct: ct > 0 ? Math.round((va / ct) * 1000) / 10 : 0,
    };
  }, [draft]);

  /** 手别分布（空态速览用） */
  const handCount = useMemo(() => {
    const m: Record<string, number> = { L: 0, R: 0, B: 0 };
    for (const d of draft) m[d.hand] = (m[d.hand] ?? 0) + 1;
    return m;
  }, [draft]);

  const totalMs = useMemo(() => {
    const end = draft.reduce((acc, d) => Math.max(acc, elEndMs(d)), 0);
    return Math.max(end, playhead, 20000);
  }, [draft, playhead]);

  const widthPx = (totalMs / 1000) * PX_PER_SEC + 40;

  /** 草稿右缘（全部要素的最大止点，ms）：自动跟随的观测对象（totalMs 含播放头/20s 下限，不适用） */
  const draftEndMs = useMemo(() => draft.reduce((m, d) => Math.max(m, elEndMs(d)), 0), [draft]);

  useEffect(() => { draftRef.current = draft; }, [draft]);

  /**
   * v3.49 时间线横向自动跟随（用户需求：片段增多后新增片段被右缘遮挡）：
   * 草稿右缘**增长**时，滚动条自动右移，使最右侧片段的止点保持可见，并在右侧
   * 至少预留 1/5 片段宽度的空白（片段宽度=止点最大者的渲染宽度），新增片段不被遮挡。
   * 不触发：右缘缩短（删除/收缩只回写基线）、已在视图内（尊重用户手动滚动位置）、
   * 拖拽进行中（防抖动反馈，pointerup 后补一次）。
   * 坐标口径：块 left 相对 tl-lane，lane 前有 40px 手别标签列（.wb-tl .tl-label），
   * 与刻度尺 44px 左移同一量级，取 44 留 4px 冗余。
   */
  const followRightEdge = useCallback(() => {
    const wrap = tlWrapRef.current;
    if (!wrap || draggingRef.current) return;
    const list = draftRef.current;
    if (list.length === 0) return;
    const last = list.reduce((best, d) => (elEndMs(d) > elEndMs(best) ? d : best));
    const endMs = elEndMs(last);
    const segW = Math.max(10, durToGrid(last.dur_s) * PX_PER_SEC);
    const target = 44 + (endMs / 1000) * PX_PER_SEC + segW / 5;
    const visibleRight = wrap.scrollLeft + wrap.clientWidth;
    if (target > visibleRight) wrap.scrollLeft = Math.ceil(target - wrap.clientWidth);
  }, []);

  useEffect(() => {
    const prev = tlEdgeRef.current;
    tlEdgeRef.current = draftEndMs;
    if (draftEndMs <= prev) return;
    // 容器未挂载（时间线收起/在「清单」页签）时记下待跟随，切回时间线再补一次
    if (tlWrapRef.current) followRightEdge();
    else tlPendingRef.current = true;
  }, [draftEndMs, followRightEdge]);

  useEffect(() => {
    if (!tlOpen || panelTab !== 'timeline' || !tlPendingRef.current) return;
    tlPendingRef.current = false;
    requestAnimationFrame(followRightEdge);
  }, [tlOpen, panelTab, followRightEdge]);

  /**
   * 视频画面实测适配（v3.15）：
   * 监看区屏幕容器由 CSS 弹性布局吃满剩余空间，这里只按容器真实尺寸反推等比帧大小——
   * 帧永远取「容器内宽高双侧贴齐的最大画面」，从根上消除黑边；窗口缩放、全屏、
   * 时间线收起等任何尺寸变化都由 ResizeObserver 触发重算（实测而非估算）。
   */
  useLayoutEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      const vw = Math.min(r.width, r.height * videoAr);
      const next = { w: Math.max(80, Math.round(vw)), h: Math.max(45, Math.round(vw / videoAr)) };
      setVideoBox((prev) => (prev && prev.w === next.w && prev.h === next.h ? prev : next));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [videoAr, isFull, tlOpen, loaded]);

  /**
   * 舞台宽度反推（v3.15.1）：画面不留黑边的关键在「舞台本身等于画面比例」。
   * 做法：主区高度 − 控制栏/边框 = 画面可用高度，× 宽高比 = 画面应有的宽度，
   * 直接把栅格左列设成这个宽度；让出的横向空间自动归检查器（表单更宽，更好填）。
   * 窗口/时间线/全屏任何尺寸变化都由 ResizeObserver 重算（实测，不估算）。
   */
  useLayoutEffect(() => {
    const main = mainRef.current;
    const stageEl = main?.querySelector('.wb-stage') as HTMLElement | null;
    const screenEl = screenRef.current;
    if (!main || !stageEl || !screenEl) return;
    const fit = () => {
      const mainH = main.clientHeight;
      const mainW = main.clientWidth;
      if (mainH < 120 || mainW < 320) return;
      // 舞台内非画面部分（控制栏 + 边框）：随宽度变化不换行，视为常量
      const chromeH = stageEl.offsetHeight - screenEl.clientHeight;
      const availH = Math.max(90, mainH - chromeH);
      const needW = availH * videoAr + 2;
      // 布局策略（v3.15.2）：视频优先获得 ≥55% 主区宽度
      // 检查器折叠时视频占满；否则检查器最小 280px（紧凑模式，表单仍可用）
      let maxW: number;
      if (inspectorCollapsed) {
        maxW = mainW; // 折叠状态：视频吃满主区
      } else {
        // 动态比例：视频至少 55%，检查器至少 280px + 间距 12px
        const inspectorMin = 280;
        const gap = 12;
        const ratioMin = Math.floor(mainW * 0.55); // 视频 ≥55%
        const inspectorBound = mainW - inspectorMin - gap; // 检器保底后的上限
        maxW = Math.max(ratioMin, inspectorBound); // 取两者中更宽的（保证视频够大）
      }
      const next = Math.round(Math.max(280, Math.min(needW, maxW)));
      setStageW((prev) => (prev === next ? prev : next));
    };
    fit();
    // 双保险：首帧布局未必稳定（顶栏折行、时间线条收放都会改变主区高度），
    // 观察主区 + 屏幕容器两者，任何一方变化都重算一次即收敛（画面宽变、高不变）
    const ro = new ResizeObserver(fit);
    ro.observe(main);
    ro.observe(stageEl);
    ro.observe(screenEl);
    const raf = requestAnimationFrame(fit);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [videoAr, isFull, tlOpen, loaded, inspectorCollapsed]);

  /** 全屏（把整个工作台铺满屏幕：视频、检查器、时间线一起变大，探索式查看用） */
  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await wbRef.current?.requestFullscreen?.();
    } catch { /* 浏览器拒绝（非用户手势等）时静默 */ }
  }, []);

  useEffect(() => {
    const onFs = () => setIsFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  /** 采样真实帧率：播放中收集 12 个相邻帧间隔，取中位数并吸附到常见档位后停止。
      服务端 canonical fps 已供数时跳过（不覆盖服务端口径，ADR-VID-001 决策 6）。 */
  useEffect(() => {
    if (fpsSampled.current || !videoUrl || serverFpsRef.current) return;
    const v = videoRef.current as any;
    if (!v || typeof v.requestVideoFrameCallback !== 'function') return;
    let last = -1;
    const samples: number[] = [];
    const onFrame = (_now: number, meta: any) => {
      const t = meta.mediaTime * 1000;
      if (last >= 0) {
        const d = t - last;
        if (d > 1 && d < 120) samples.push(d);
      }
      last = t;
      if (samples.length < 12) { v.requestVideoFrameCallback(onFrame); return; }
      samples.sort((a, b) => a - b);
      const guess = 1000 / samples[Math.floor(samples.length / 2)];
      const COMMON = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];
      const best = COMMON.reduce((prev, cur) => (Math.abs(cur - guess) < Math.abs(prev - guess) ? cur : prev), COMMON[0]);
      fpsSampled.current = true;
      setFps(best);
    };
    v.requestVideoFrameCallback(onFrame);
  }, [videoUrl]);

  /** 帧步进引擎配置同步（SPEC-VID-P0 §6）：切源 / 帧率变化 / 代理就绪时重绑。
      keyframeList（P0.5 服务端来源）：index.json 的 keyframes（源 I 帧时刻，毫秒）→ 秒——
      代理未就绪回退原始视频时吸附最近 I 帧（原为退化 1/fps 网格）；代理就绪后步进逐帧精确。 */
  useEffect(() => {
    engine.load(videoRef.current, { fps, proxyActive, keyframeList: keyframesSec });
  }, [engine, fps, proxyActive, videoUrl, keyframesSec]);

  /** 定位播放头（行业惯例：定位即暂停——帧级查看模式，空格恢复播放） */
  const seek = (ms: number) => {
    const v = videoRef.current;
    const maxMs = v && Number.isFinite(v.duration) ? v.duration * 1000 : Math.max(0, ms);
    const clamped = Math.round(Math.min(maxMs, Math.max(0, ms)));
    setPlayhead(clamped);
    segEndRef.current = null;
    segFinishedRef.current = false;
    if (v) {
      if (!v.paused) v.pause();
      v.currentTime = clamped / 1000;
    }
  };

  const onVideoTime = () => {
    const v = videoRef.current;
    // 暂停后的迟到 timeupdate 不得覆盖停止回调写入的真实呈现帧；定位/帧步进本身会显式回写播放头。
    if (v && !v.paused) setPlayhead(Math.round(v.currentTime * 1000));
  };

  /** 帧级定位（useVideoEngine 版 seek：定位即暂停 + 播放头回写，语义与 seek 一致） */
  const seekFrame = (frame: number) => {
    const v = videoRef.current;
    if (v && !v.paused) v.pause();
    engine.seekToFrame(frame);
    segEndRef.current = null;
    segFinishedRef.current = false;
    if (v) setPlayhead(Math.round(v.currentTime * 1000));
  };

  /** 单帧步进（v3.57 收编：←/→ 键与传输条 ←/→ 按钮统一入口）。
      旧实现 seek(playhead ± frameMs) 吃闭包陈旧 playhead + 浏览器 seek 关键帧吸附，
      连点会漂移；改走 engine.stepFrame（SPEC-VID-P0 §6：以 v.currentTime 为真值源，
      f=round(t×fps)+dir 帧网格精确落帧；代理视频逐帧精确，原始视频 1/fps 网格 = 原精度不劣化）。
      Shift/Alt 步长变体保持旧 seek 路径（1s 粗跳 / 1/4 帧——后者低于帧网格精度，语义不变）。 */
  const stepFrameBy = (dir: -1 | 1) => {
    const v = videoRef.current;
    if (!v) { seek(Math.max(0, playhead + dir * frameMs)); return; }
    if (!v.paused) v.pause();
    engine.stepFrame(dir);
    setPlayhead(Math.round(v.currentTime * 1000));
    segEndRef.current = null;
    segFinishedRef.current = false;
  };

  /* rAF 平滑播放头；单次片段另用 requestVideoFrameCallback 在实际呈现帧到止点时暂停。
     不再先越过止点再回写 currentTime——反向 seek 会让用户看到明确的回帧。 */
  useEffect(() => {
    if (!playing) return;
    const v = videoRef.current as any;
    let raf = 0;
    let videoFrame = 0;
    const hasFrameCallback = Boolean(v && typeof v.requestVideoFrameCallback === 'function');
    const stopSingle = () => {
      const sel = selRef.current;
      if (!v || !sel) return;
      v.pause();
      // 停止后的时间码显示清单的逻辑止点；视频真实停帧不回写，避免视觉回帧。
      setPlayhead(elEndMs(sel));
      segEndRef.current = null;
      segFinishedRef.current = true;
    };

    if (hasFrameCallback) {
      const onFrame = (_now: number, metadata: { mediaTime: number }) => {
        const sel = selRef.current;
        if (!v.paused && sel && segEndRef.current != null && !segLoopRef.current &&
            metadata.mediaTime * 1000 >= elEndMs(sel)) {
          stopSingle();
          return;
        }
        if (!v.paused) videoFrame = v.requestVideoFrameCallback(onFrame);
      };
      videoFrame = v.requestVideoFrameCallback(onFrame);
    }

    const tick = () => {
      if (v && !v.paused) {
        const ms = Math.round(v.currentTime * 1000);
        const sel = selRef.current;
        if (sel && segEndRef.current != null && ms >= elEndMs(sel)) {
          if (segLoopRef.current) {
            const from = Math.max(0, sel.start_ms - PREROLL_MS);
            v.currentTime = from / 1000;
            setPlayhead(from);
          } else if (!hasFrameCallback) {
            // 无 rVFC 的浏览器由 rAF 兜底：同样直接暂停，绝不向后 seek。
            stopSingle();
          } else {
            // 等本轮呈现回调停止；播放头钳在止点，避免先向右越界再向左回写。
            setPlayhead(elEndMs(sel));
          }
        } else {
          setPlayhead(ms);
        }
      }
      if (!v || !v.paused) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      if (hasFrameCallback && videoFrame) v.cancelVideoFrameCallback(videoFrame);
    };
  }, [playing]);

  /** 选中要素变化：同步 selRef；取消选中即退出片段模式 */
  useEffect(() => {
    selRef.current = selectedElement;
    segFinishedRef.current = false;
    if (!selectedElement) segEndRef.current = null;
  }, [selectedElement]);

  /* 播放速度即时应用（video.playbackRate） */
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, videoUrl]);

  /** 起播（空格 / 播放按钮 / 点击视频共用；L 连续正放另有独立入口）：选中要素时进入片段模式——
      默认单次：从「起点-预卷0.4s」起播，实际呈现帧到达止点即停，不再回退 seek；
      循环开关开启则回到起点反复播。片段区间随拖拽边界实时生效。 */
  const startPlay = useCallback((rate?: number) => {
    const v = videoRef.current;
    if (!v) return;
    const replayFinished = segFinishedRef.current;
    segFinishedRef.current = false;
    const sel = selRef.current;
    if (sel) {
      const end = elEndMs(sel);
      const from = Math.max(0, sel.start_ms - PREROLL_MS);
      const ph = Math.round(v.currentTime * 1000);
      // 自然播完后第一次空格直接重播；呈现帧到止点时 currentTime 可能仍略早于 end。
      if (replayFinished || ph < from || ph >= end) {
        v.currentTime = from / 1000;
        setPlayhead(from);
      }
      segEndRef.current = end;
    } else {
      segEndRef.current = null;
      segFinishedRef.current = false;
    }
    v.playbackRate = rate ?? speed;
    void v.play().catch(() => setPlaying(false));
  }, [speed]);

  /** 播放/暂停（空格键与按钮共用；play() 异步需 catch）。 */
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) startPlay();
    else v.pause();
  }, [startPlay]);

  /**
   * JKL 传输三键：
   *  J 按住 = 按帧回退倒放，Shift+J = 后退 10 帧；L 按住 = 连续正放，松开即停帧对齐。
   *  K = 播放/暂停：暂停时从当前播放头连续正放，播放时暂停并帧对齐。
   *  K/L 连续正放都不进片段模式、不设止点、不回卷；空格与播放按钮才负责片段单次/循环播放。
   */
  const lHeldRef = useRef(false);
  const jHeldRef = useRef(false);
  const jTimerRef = useRef<number | null>(null);
  /** 连续恢复播放：清除片段止点哨兵，尤其不能在要素止点处重新预卷起播。 */
  const playContinuous = () => {
    const v = videoRef.current;
    if (!v) return;
    segEndRef.current = null;
    segFinishedRef.current = false;
    v.playbackRate = speed;
    void v.play().catch(() => setPlaying(false));
  };
  /** K 播放/暂停：恢复时走连续正放，避免在片段止点重新预卷起播。 */
  const toggleContinuousPlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { playContinuous(); return; }
    v.pause();
    const stopped = Math.round(v.currentTime * 1000);
    const snapped = Math.round(Math.round(stopped / frameMs) * frameMs);
    setPlayhead(snapped);
    segEndRef.current = null;
    segFinishedRef.current = false;
  };
  const shuttleHoldStart = () => {
    if (lHeldRef.current) return;
    lHeldRef.current = true;
    playContinuous();
  };
  const shuttleHoldEnd = () => {
    if (!lHeldRef.current) return;
    lHeldRef.current = false;
    const v = videoRef.current;
    if (v && !v.paused) {
      v.pause();
      /* 松开即停：与 K 同样帧对齐——走 useVideoEngine.snapToFrameGrid（SPEC-VID-P0 §6：
         代理吸附最近 1/fps 吸收浮点误差；非代理吸附最近关键帧；v3.29 取整到整数毫秒） */
      engine.snapToFrameGrid();
      setPlayhead(Math.round(v.currentTime * 1000));
      segEndRef.current = null;
      segFinishedRef.current = false;
    }
  };
  /** J 倒放结束（先声明：jShuttleStart 的首帧 tick 同步路径可能立即触底调用） */
  const jShuttleEnd = () => {
    if (!jHeldRef.current && jTimerRef.current == null) return;
    jHeldRef.current = false;
    if (jTimerRef.current != null) {
      window.clearInterval(jTimerRef.current);
      jTimerRef.current = null;
    }
  };
  /** J 按帧倒放：暂停态 + 定时器步进退帧；以 v.currentTime 为真值源。 */
  const jShuttleStart = () => {
    const v = videoRef.current;
    if (!v || jHeldRef.current) return;
    jHeldRef.current = true;
    segFinishedRef.current = false;
    if (!v.paused) v.pause();
    const interval = Math.max(16, Math.round(frameMs / speed));
    const tick = () => {
      engine.stepFrame(-1);
      const next = v.currentTime;
      setPlayhead(Math.round(next * 1000));
      if (next <= 0) jShuttleEnd();
    };
    tick();
    jTimerRef.current = window.setInterval(tick, interval);
  };
  useEffect(() => () => { if (jTimerRef.current != null) window.clearInterval(jTimerRef.current); }, []);

  /** 边界集合：所有要素起止点去重升序（↑/↓ 在边界间跳转） */
  const boundaries = useMemo(() => {
    const set = new Set<number>();
    for (const d of draft) { set.add(Math.round(d.start_ms)); set.add(elEndMs(d)); }
    return [...set].sort((a, b) => a - b);
  }, [draft]);

  const jumpBoundary = (dir: 'prev' | 'next') => {
    const eps = frameMs / 2;
    if (dir === 'prev') {
      const prev = [...boundaries].reverse().find((b) => b < playhead - eps);
      if (prev !== undefined) seek(prev);
    } else {
      const next = boundaries.find((b) => b > playhead + eps);
      if (next !== undefined) seek(next);
    }
  };

  /** 找覆盖播放头的要素（分割动作的目标：无需先点选） */
  const elementAtPlayhead = useCallback(() =>
    draft.find((d) => playhead >= d.start_ms && playhead < elEndMs(d)) ?? null,
    [draft, playhead]);

  const splitAtPlayhead = (key?: string) => {
    const targetKey = key ?? elementAtPlayhead()?.key ?? null;
    if (!targetKey) return;
    setSubmitted(false); // v3.45 草稿脏检查（P1-1）：结构性变更复位 submitted
    setDraft((prev) => {
      const target = prev.find((d) => d.key === targetKey);
      if (!target) return prev;
      const end = elEndMs(target);
      /* v3.29：分割点取整到整数毫秒（播放头可能是帧量化分数值，如 2066.67ms） */
      const splitMs = Math.max(0, Math.round(playhead));
      if (splitMs <= target.start_ms + frameMs || splitMs >= end - frameMs) return prev;
      const firstDur = durToGrid((splitMs - target.start_ms) / 1000);
      /* 第二半起点 = 第一半起点 + 第一半网格化时长——恒等于后端 V2 止点公式，
         两半在服务端判定中逐毫秒连续，杜绝 1~5ms 幻影"时间重叠"（根因：旧实现第二半
         起点取分数播放头原值，而第一半时长按 10ms 取整，两端舍入方向不一致） */
      const secondStart = target.start_ms + Math.round(firstDur * 1000);
      const first: Draft = { ...target, dur_s: firstDur };
      const second: Draft = {
        ...target,
        key: `${target.key}-s${Date.now()}`,
        start_ms: secondStart,
        dur_s: durToGrid((end - secondStart) / 1000),
      };
      return prev.flatMap((d) => (d.key === targetKey ? [first, second] : d));
    });
  };

  /** 使时间段连续（v3.55，用户需求）：右键片段 → 弹出确认 → 把该片段起点对齐到
      「相邻上一个片段」（按 start_ms 升序的前一个要素）的止点。
      **止点保持不变**：新起点 = 上一片段止点，新时长 = 原止点 - 新起点（长度可变、止点不动）。
      目标已是第一个片段（无前一个）时提示；起点与目标一致时无操作；
      上一片段止点已 ≥ 本片段止点（新时长为非正）时提示无法操作。 */
  const makeContiguous = () => {
    if (!contiguousTarget) return;
    const target = contiguousTarget.el;
    const sorted = [...draft].sort((a, b) => a.start_ms - b.start_ms);
    const idx = sorted.findIndex((d) => d.key === target.key);
    if (idx <= 0) {
      setFlash(`#${target.seq} 已是第一个片段，没有可对齐的上一个片段`);
      setTimeout(() => setFlash(null), 2200);
      setContiguousTarget(null);
      return;
    }
    const prev = sorted[idx - 1];
    const prevEnd = elEndMs(prev);
    const curEnd = elEndMs(target); // 止点，保持不变
    if (Math.round(target.start_ms) === prevEnd) {
      setFlash(`#${target.seq} 起点已与 #${prev.seq} 止点连续（${fmtTimecode(prevEnd)}）`);
      setTimeout(() => setFlash(null), 2200);
      setContiguousTarget(null);
      return;
    }
    const newDurMs = curEnd - prevEnd; // 新时长（ms）
    if (newDurMs <= 0) {
      setFlash(`#${target.seq} 无法连续：#${prev.seq} 止点（${fmtTimecode(prevEnd)}）已在本片段止点之后`);
      setTimeout(() => setFlash(null), 2600);
      setContiguousTarget(null);
      return;
    }
    /* 止点不动、长度可变：起点对齐上一止点，时长改为「原止点 - 新起点」并量化到 10ms 网格 */
    update(target.key, {
      start_ms: Math.round(prevEnd),
      dur_s: durToGrid(newDurMs / 1000),
    });
    setFlash(`#${target.seq} 起点 → ${fmtTimecode(prevEnd)}（止点 ${fmtTimecode(curEnd)} 不变）`);
    setTimeout(() => setFlash(null), 2500);
    setContiguousTarget(null);
  };

  /** 新增要素：dupFrom 传入时复制其属性（“同上”快速记录：流水线动作类型重复率高）。
      手别默认"双手"并跨要素延续（用户反馈：选过 L/R 后续要素沿用，省去逐要素点选）。
      v3.26 连续生成（用户反馈）：编号=当前最大编号+1（删条后不再跳号/重号）；
      时间起点=前一动作要素的止点（首条例外：落播放头）——各片段拼接为连续时间轴，不留空缺；
      默认时长取交付参数区「新片段」设定（同上新增沿用来源要素时长）。 */
  const addElement = (dupFrom?: Draft): Draft => {
    const key = `new-${Date.now()}`;
    setSubmitted(false); // v3.45 草稿脏检查（P1-1）：新增要素复位 submitted（addSameAsLast/commitAndNext 同走此函数）
    /* 连续起点=全部要素的最大止点（止点按 elEndMs=后端 V2 同公式计算，链接起点与落库止点逐毫秒一致；
       不取"最后起始要素"的止点——拖拽交叉时后者会回退重叠） */
    const prevEnd = draft.reduce((m, d) => Math.max(m, elEndMs(d)), 0);
    const maxSeq = draft.reduce((m, d) => Math.max(m, d.seq), 0);
    const base: Draft = {
      key,
      seq: maxSeq + 1,
      /* 首条例外：落播放头（v3.29：取整到整数毫秒，与 start_ms 的 INT 列一致） */
      start_ms: draft.length > 0 ? Math.round(prevEnd) : Math.max(0, Math.round(playhead)),
      /* v3.29：默认时长量化到 10ms 网格（与 DECIMAL(10,2) 存储一致，杜绝链接/落库舍入错位） */
      dur_s: durToGrid(dupFrom ? dupFrom.dur_s : newDurS),
      hand: dupFrom ? dupFrom.hand : handMemo,
      type: '拿取',
      desc: '新要素',
      va_class: typeDefaultOf('拿取'),
      va_reason: '',
      outlier_flag: 0,
      outlier_reason: '',
      rating: 1,
      allowance: 0.15,
      // 新建要素未评定：界面显"未评定"，督促提交前集中评定（会审 P0-1）
      rated: undefined,
    };
    if (dupFrom) {
      Object.assign(base, {
        hand: dupFrom.hand, type: dupFrom.type, va_class: dupFrom.va_class,
        rating: dupFrom.rating, allowance: dupFrom.allowance,
        desc: dupFrom.desc, outlier_flag: 0, outlier_reason: '',
        rated: dupFrom.rated,
      });
    }
    setHandMemo(base.hand);
    setDraft((prev) => [...prev, base]);
    setSelected(key);
    /* v3.26 对象继承预填：不整体复制上一要素——结构化字段草稿按「上一动作→拿取（默认型）」判定重建
       （yes/conditional 才带对象值进来，其余字段一律空，由用户按新动作填）；真正的预填发生在
       用户选定下一动作类型的 onChange（彼时才知道下一动作是什么）。 */
    const prevEl = draft.length > 0
      ? draft.reduce((best, d) => (elEndMs(d) > elEndMs(best) ? d : best))
      : null;
    const { vals, hint } = carrySdFor(prevEl, base.type);
    setSdValues(vals);
    setSdReach('');
    setCarryHint(hint ? { key, msg: hint } : null);
    return base;
  };

  const addSameAsLast = () => {
    const sorted = [...draft].sort((a, b) => a.start_ms - b.start_ms);
    addElement(sorted[sorted.length - 1] ?? undefined);
  };

  /**
   * 完成当前要素并进入下一个（回车 / "完成·下一个"按钮 / Ctrl+Enter / 工具箱共用）。
   * 语义：本地草稿即刻记录（最终入库仍走提交分解）→ 选中下一要素并把播放头带过去。
   * 已是最后一个则按连续生成新建一个（起点=当前止点，v3.26），形成流水线式连续记录。
   * v3.27 焦点策略（用户实测反馈）：完成后**不聚焦描述框，主动失焦到 body**——
   * 现场习惯是「填完本条 → 紧接按 L 播视频 → 用 I/O 定下一要素起止点」，
   * 焦点落输入框会把 L 吃成文本（全局快捷键在 INPUT 聚焦时整体让位），还要多点一次鼠标。
   * 需要填描述/结构化字段时点一下即可（Tab 亦可）；「编辑」按钮仍聚焦描述框（显式编辑意图）。
   */
  const commitAndNext = () => {
    const sorted = [...draft].sort((a, b) => a.start_ms - b.start_ms);
    const idx = selected ? sorted.findIndex((d) => d.key === selected) : -1;
    const current = idx >= 0 ? sorted[idx] : null;
    const next = idx >= 0 ? sorted[idx + 1] : sorted[0] ?? null;
    setSubmitted(false); // v3.45 草稿脏检查（P1-1）：记录流转中视为草稿变更（无下一条时经 addElement 新建）
    if (current) {
      setFlash(`已记录 #${current.seq} ${current.desc}（共 ${draft.length} 条）`);
      setTimeout(() => setFlash(null), 2000);
    }
    if (next) {
      setSelected(next.key);
      seek(next.start_ms);
    } else {
      const created = addElement();
      seek(created.start_ms);
    }
    // 主动失焦：按钮/输入框都不留焦点——L/J/K/I/O/空格等全局快捷键即时生效，
    // 也避免焦点留在「完成·下一个」按钮上时空格/回车重复触发提交。
    (document.activeElement as HTMLElement | null)?.blur();
  };

  /**
   * 设起点 / 设止点（剪辑软件 I/O 惯例，快捷键 I / O）：把选中要素的边界直接落到播放头。
   * 修正误标的快速回路：←→ 逐帧对准 → 按 I/O 即改——不拖块、不滚检查器、不敲数字。
   * 边界非法（起点≥止点）时自动顺延一帧，时长恒为正（最小时长 = 1 帧）。
   */
  const setStartAtPlayhead = () => {
    if (!selected) { setFlash('先在时间线上选中一个要素，再设起点'); setTimeout(() => setFlash(null), 2000); return; }
    const el = draft.find((d) => d.key === selected);
    if (!el) return;
    const s = Math.max(0, Math.round(playhead));
    const end = elEndMs(el);
    /* v3.29：时长按 10ms 网格量化——止点恒等于 s + round(dur*1000)，与后端存储口径一致 */
    if (s + frameMs >= end) update(selected, { start_ms: s, dur_s: durToGrid(frameMs / 1000) });
    else update(selected, { start_ms: s, dur_s: durToGrid((end - s) / 1000) });
    setFlash(`#${el.seq} 起点 → ${fmtTime(s)}`);
    setTimeout(() => setFlash(null), 2000);
  };

  const setEndAtPlayhead = () => {
    if (!selected) { setFlash('先在时间线上选中一个要素，再设止点'); setTimeout(() => setFlash(null), 2000); return; }
    const el = draft.find((d) => d.key === selected);
    if (!el) return;
    const end = Math.max(0, Math.round(playhead));
    if (end <= el.start_ms) update(selected, { dur_s: durToGrid(frameMs / 1000) });
    else update(selected, { dur_s: durToGrid((end - el.start_ms) / 1000) });
    setFlash(`#${el.seq} 止点 → ${fmtTime(end)}`);
    setTimeout(() => setFlash(null), 2000);
  };

  /**
   * 边界微调（NLE Trim 惯例，v3.19）：选中要素的起/止点按帧步进——
   * `,` 起点−1帧 · `.` 起点+1帧 · `[` 止点−1帧 · `]` 止点+1帧；Shift = ×10 帧。
   * 与 I/O（边界落到播放头）互补：I/O 适合"先逐帧对准再落点"，Trim 键适合"边看边拧"——
   * 不拖块、不滚检查器、不敲数字。拖拽只适合粗调（40px/s 刻度下 1 帧≈1.3px，鼠标不可能准），
   * 精修必须走键盘——这是 Premiere/Resolve/剪映的共同答案。非法边界自动顺延一帧（最小时长 1 帧）。
   */
  const nudgeEdge = (side: 'start' | 'end', dir: -1 | 1, frames = 1) => {
    if (!selected) { setFlash('先在时间线上选中一个要素，再微调边界'); setTimeout(() => setFlash(null), 2000); return; }
    const el = draft.find((d) => d.key === selected);
    if (!el) return;
    const step = frameMs * frames;
    const end = elEndMs(el);
    /* v3.29：边界取整到整数毫秒、时长量化到 10ms 网格——止点恒等于 start + round(dur*1000) */
    if (side === 'start') {
      const s = Math.round(Math.max(0, Math.min(el.start_ms + dir * step, end - frameMs)));
      update(selected, { start_ms: s, dur_s: durToGrid((end - s) / 1000) });
      setFlash(`#${el.seq} 起点 ${dir < 0 ? '−' : '+'}${frames} 帧 → ${fmtTime(s)}`);
    } else {
      const e = Math.round(Math.max(el.start_ms + frameMs, end + dir * step));
      update(selected, { dur_s: durToGrid((e - el.start_ms) / 1000) });
      setFlash(`#${el.seq} 止点 ${dir < 0 ? '−' : '+'}${frames} 帧 → ${fmtTime(e)}`);
    }
    setTimeout(() => setFlash(null), 2000);
  };

  /** 删除要素（单级可撤销，避免误删重录） */
  const deleteElement = (key: string) => {
    const index = draft.findIndex((d) => d.key === key);
    if (index === -1) return;
    const item = draft[index];
    setSubmitted(false); // v3.45 草稿脏检查（P1-1）：删除复位 submitted
    setDraft((prev) => prev.filter((d) => d.key !== key));
    if (selected === key) setSelected(null);
    setLastDeleted({ item, index });
    setTimeout(() => setLastDeleted((cur) => (cur?.item.key === key ? null : cur)), 30000);
  };

  const undoDelete = () => {
    if (!lastDeleted) return;
    const { item, index } = lastDeleted;
    setSubmitted(false); // v3.45 草稿脏检查（P1-1）：撤销删除同样是草稿变更
    setDraft((prev) => {
      const next = [...prev];
      next.splice(Math.min(index, next.length), 0, item);
      return next;
    });
    setSelected(item.key);
    setLastDeleted(null);
    setFlash(`已恢复 #${item.seq} ${item.desc}`);
    setTimeout(() => setFlash(null), 2000);
  };

  /** 一键清空（v3.41，用户需求）：清空当前未提交的全部草稿要素重新开始；二次确认防误触 */
  const clearAll = () => {
    if (draft.length === 0) return;
    const okGo = window.confirm(
      `清空当前全部 ${draft.length} 条未提交的动作要素？\n\n`
      + '此操作只影响本地草稿（未提交到服务器），清空后从零重新开始记录；已提交过的版本数据不受影响。',
    );
    if (!okGo) return;
    setDraft([]);
    setSelected(null);
    setLastDeleted(null);
    setSubmitted(false);
    setIssues([]); setWarnings([]); setMsg(null);
    setFlash(`已清空 ${draft.length} 条草稿要素，可重新开始`);
    setTimeout(() => setFlash(null), 2500);
    // 清空后焦点回 body（v3.27 焦点策略：不留焦点在按钮上，L/I/O 立即可用）
    (document.activeElement as HTMLElement | null)?.blur?.();
  };

  const setHandOfSelected = (hand: Draft['hand']) => {
    if (selected) { update(selected, { hand }); setHandMemo(hand); }
  };

  const stepSpeed = (dir: -1 | 1) => {
    const idx = SPEED_STEPS.findIndex((v) => v === speed);
    const next = SPEED_STEPS[Math.min(SPEED_STEPS.length - 1, Math.max(0, (idx === -1 ? SPEED_STEPS.length - 1 : idx) + dir))];
    setSpeed(next);
  };

  /* ---- 快捷键（对齐 OTRS/视频标注惯例；不在界面上展示提示，仅 ? 浮层可查） ---- */
  /** 动作要素下拉打开中：屏蔽全局快捷键（↑↓/Enter/Esc 交给下拉自身消费，避免双重触发） */
  const typeMenuOpenRef = useRef(false);
  /** 类型按钮聚焦中（v3.20 typeahead）：单键快捷键让位给类型检索（Esc 例外，仍可取消选中） */
  const typeBtnFocusRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (typeMenuOpenRef.current) return;
      const target = e.target as HTMLElement | null;
      const inField = Boolean(target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));

      // Ctrl/Cmd+Enter = 完成·下一个：输入框聚焦时同样生效（描述框内回车已单触，这里防重）
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        if (canWrite) commitAndNext();
        return;
      }
      // Ctrl/Cmd+K = 快捷工具箱（v3.20 命令面板）：输入框聚焦时同样可唤起
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setToolboxOpen((v) => !v);
        return;
      }
      if (typeBtnFocusRef.current && e.key !== 'Escape') return;
      if (inField && e.key !== 'Escape') return;

      const k = e.key;
      if (k === 'f' || k === 'F') { e.preventDefault(); void toggleFullscreen(); return; }
      if (k === 'Escape') { setShowHelp(false); setSelected(null); target?.blur?.(); return; }
      if (k === '?') { e.preventDefault(); setShowHelp((v) => !v); return; }
      if (k === ' ') { e.preventDefault(); togglePlay(); return; }
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        const dir = k === 'ArrowLeft' ? -1 : 1;
        // v3.57 收编引擎：默认一帧走 stepFrameBy（帧网格精确，连点不漂移）；
        // Shift = 1 秒粗跳、Alt = 1/4 帧（低于帧网格精度）仍走 seek（旧路径语义不变）
        if (e.shiftKey || e.altKey) {
          const step = e.shiftKey ? 1000 : frameMs / 4;
          seek(Math.max(0, playhead + dir * step));
        } else {
          stepFrameBy(dir);
        }
        return;
      }
      if (k === 'ArrowUp') { e.preventDefault(); jumpBoundary('prev'); return; }
      if (k === 'ArrowDown') { e.preventDefault(); jumpBoundary('next'); return; }
      if (k === 'Home') { e.preventDefault(); seek(0); return; }
      if (k === 'End') { e.preventDefault(); seek(totalMs); return; }
      if (k === '-') { e.preventDefault(); stepSpeed(-1); return; }
      if (k === '+' || k === '=') { e.preventDefault(); stepSpeed(1); return; }
      // J 按住倒放；K 播放/暂停；L 按住正放、松开即停。
      if (k === 'j' || k === 'J') {
        e.preventDefault();
        if (e.shiftKey) {
          seekFrame(engine.currentFrame() - 10);
        } else if (!e.repeat) {
          jShuttleStart();
        }
        return;
      }
      if (k === 'k' || k === 'K') {
        e.preventDefault();
        // 屏蔽系统自动重复，避免长按 K 在播放与暂停之间反复切换。
        if (!e.repeat) toggleContinuousPlay();
        return;
      }
      if (k === 'l' || k === 'L') {
        e.preventDefault();
        // 按住式（用户定稿：无加速档）：首个 keydown（非 repeat）起播，松开（keyup）即停
        if (!e.repeat) shuttleHoldStart();
        return;
      }
      if (!canWrite) return;
      if (k === 's' || k === 'S') { splitAtPlayhead(); return; }
      if (k === 'n' || k === 'N') { addElement(); return; }
      if (k === 'd' || k === 'D') { addSameAsLast(); return; }
      if ((k === 'Delete' || k === 'Backspace') && selected) {
        e.preventDefault();
        deleteElement(selected);
        return;
      }
      if (k === '1') { setHandOfSelected('L'); return; }
      if (k === '2') { setHandOfSelected('R'); return; }
      if (k === '3') { setHandOfSelected('B'); return; }
      // 设起点 / 设止点（剪辑软件 I/O 惯例）：边界落到播放头，逐帧对准后一键修正
      if (k === 'i' || k === 'I') { setStartAtPlayhead(); return; }
      if (k === 'o' || k === 'O') { setEndAtPlayhead(); return; }
      // 边界微调（NLE Trim 惯例，v3.19）：, . [ ] 按帧拧选中要素的起/止点，Shift = ×10 帧。
      // 拖拽只适合粗调（40px/s 下 1 帧≈1.3px，鼠标不可能准）；精修走键盘，边看边拧不掉焦点。
      // Shift 变体（美式键盘 Shift+, = '<' 等）同样识别，frames 由 shiftKey 决定，与具体字符无关。
      const trimKey = k === ',' || k === '<' ? 'start-' : k === '.' || k === '>' ? 'start+' : k === '[' || k === '{' ? 'end-' : k === ']' || k === '}' ? 'end+' : null;
      if (trimKey) {
        e.preventDefault();
        const frames = e.shiftKey ? 10 : 1;
        if (trimKey === 'start-') nudgeEdge('start', -1, frames);
        else if (trimKey === 'start+') nudgeEdge('start', 1, frames);
        else if (trimKey === 'end-') nudgeEdge('end', -1, frames);
        else nudgeEdge('end', 1, frames);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    /* L/J 松开即停：L 帧对齐，J 清倒放定时器。 */
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'l' || e.key === 'L') shuttleHoldEnd();
      else if (e.key === 'j' || e.key === 'J') jShuttleEnd();
    };
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  });

  /**
   * 拖拽要素边界（磁吸版 v3.15.2）：
   * 候选目标 = 其他要素的起/止边界 + 播放头 + 0 点，12px 内最近者优先吸附（同时间轴对齐，跨手也算——
   * 双手并行时视觉上仍要落在同一刻度上）；命中后再按实测帧长量化，保证帧级精确。
   * 拖拽中：轨道上出竖向参考线（蓝），光标旁出时间提示浮签——松手即得"紧密贴合"的边界。
   *
   * 磁吸阈值从 8px 提高到 12px（更易触发吸附，减少微调操作）；
   * 吸附结果精确等于候选值（不做额外舍入），候选集合包含所有其他要素的 start_ms/end_ms。
   */
  const startDrag = (event: React.PointerEvent, element: Draft, side: 'l' | 'r') => {
    event.stopPropagation();
    event.preventDefault();
    draggingRef.current = true; // v3.49 自动跟随抑制：拖拽中不滚动（见 followRightEdge）
    const startX = event.clientX;
    const originStart = element.start_ms;
    /* v3.29：止点按 elEndMs（后端 V2 同公式）取——拖拽中时长量化后止点不漂移 */
    const originEnd = elEndMs(element);
    const msPerPx = 1000 / PX_PER_SEC;
    const SNAP_PX = 12; // 磁吸阈值（像素）：从 8px 提高到 12px，更易触发吸附
    const snapTol = SNAP_PX * msPerPx;

    // 收集所有磁吸候选锚点（其他要素的起止边界 + 播放头 + 零点）
    const candidates: number[] = [];
    for (const d of draft) {
      if (d.key === element.key) continue;
      candidates.push(d.start_ms, elEndMs(d));
    }
    candidates.push(playhead, 0);
    console.debug('[snap] candidates=', candidates.map(c => `${c}ms`).join(', '), `tol=${snapTol.toFixed(1)}ms`);

    const onMove = (ev: PointerEvent) => {
      const rawDelta = (ev.clientX - startX) * msPerPx;
      const rawTarget = side === 'l'
        ? Math.max(0, Math.min(originStart + rawDelta, originEnd - frameMs))
        : Math.max(originStart + frameMs, originEnd + rawDelta);
      // 磁吸：阈值内取最近候选（精确等于候选值，不做帧量化——候选本身就是边界）
      let snap: number | null = null;
      let bestDist = Infinity;
      for (const c of candidates) {
        const dist = Math.abs(c - rawTarget);
        if (dist <= snapTol && dist < bestDist) { snap = c; bestDist = dist; }
      }
      /* v3.29：落点一律取整到整数毫秒（与 start_ms 的 INT 列一致）——旧实现磁吸命中
         分数播放头（帧量化 33.33ms 步进）时 start_ms 为分数，与 10ms 网格时长叠加产生幻影重叠 */
      const edgeMs = snap != null ? Math.round(snap) : Math.round(Math.round(rawTarget / frameMs) * frameMs);
      // 磁吸调试日志：吸附结果精确等于候选值，不做额外舍入
      if (snap !== null) {
        console.debug(`[snap] HIT → edge=${edgeMs}ms (dist=${bestDist.toFixed(1)}ms, candidate exact)`);
      }
      let nextStart = originStart;
      let nextEnd = originEnd;
      if (side === 'l') {
        nextStart = Math.round(Math.max(0, Math.min(edgeMs, originEnd - frameMs)));
        nextEnd = originEnd;
      } else {
        nextEnd = Math.round(Math.max(originStart + frameMs, edgeMs));
      }
      /* v3.29：时长按 10ms 网格量化——止点恒等于 nextStart + round(dur*1000) */
      const dur = durToGrid((nextEnd - nextStart) / 1000);
      update(element.key, {
        start_ms: nextStart,
        dur_s: dur,
      });
      setDragInfo({
        snapMs: snap,
        x: ev.clientX,
        y: ev.clientY,
        text: side === 'l'
          ? `起点 ${nextStart}ms · 时长 ${dur}s`
          : `止点 ${nextEnd}ms · 时长 ${dur}s`,
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragInfo(null);
      /* v3.49：拖拽结束补一次自动跟随——拖拽中被抑制的增长（如右缘拖出视图）在此结算；
       * rAF 等最后一帧 setDraft 落幕、draftRef 刷新后再算右缘 */
      draggingRef.current = false;
      requestAnimationFrame(followRightEdge);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /**
   * 时间线空白定位（v3.22 双击语义）：双击空白道 = 定位播放头；
   * 单击空白道**不再移动播放头**（用户反馈：误触即偏移，找回来要重新逐帧对准）。
   * I/O 精修回路不受影响：定位（dblclick）→ 选中丢失时点块选中（单击）→ I/O 落边界。
   */
  const onLaneClick = (_hand: 'L' | 'R' | 'B', _event: React.MouseEvent) => {
    /* v3.22：单击空白道 = 无操作（保留 hook 以便未来加 hover 态）；定位一律双击 */
  };

  const onLaneDoubleClick = (hand: 'L' | 'R' | 'B', event: React.MouseEvent) => {
    const lane = lanesRef.current[hand];
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    const px = event.clientX - rect.left;
    seek(Math.max(0, Math.round(px / PX_PER_SEC * 1000)));
  };

  const buildPayload = () => {
    const ordered = [...draft].sort((a, b) => a.start_ms - b.start_ms).map((d, index) => ({ ...d, seq: index + 1 }));
    const elements = ordered.map((d) => {
      const def = typeDefaultOf(d.type);
      let desc = d.desc.trim();
      if (d.va_class !== def && !desc.includes('[VA改判') && d.va_reason.trim()) {
        desc = `${desc} [VA改判|原:${def}|新:${d.va_class}|理由:${d.va_reason.trim()}|人:IE|${today()}]`;
      }
      // 无理由的改判不追加标记 → 后端 V1 校验拦截（va_class 与类型默认不一致须带改判标记），强制补理由
      return {
        seq: d.seq,
        start_ms: Math.round(d.start_ms),
        /* v3.29：传输前量化到 10ms 网格——线上前端任何入口（含手输）都不会把
           非网格时长送上接口，校验/落库/自动链三方口径恒等 */
        dur_s: durToGrid(d.dur_s),
        hand: d.hand,
        type: d.type,
        desc,
        va_class: d.va_class,
        outlier_flag: d.outlier_flag,
        outlier_reason: d.outlier_reason,
        rating: d.rating,
        allowance: d.allowance,
        /* v3.47 双线隔离：来源必须显式回传。AI 自动分解写入的要素保持 'ai_assisted'，
           其余一律 'manual'。不传会被 elements.service 兜底成 manual，造成 AI 成果静默降级。 */
        source: d.source === 'ai_assisted' ? ('ai_assisted' as const) : ('manual' as const),
      };
    });
    return { bol_version: loaded?.station.version, cycle_count: cycles, cv, elements };
  };

  const runValidate = async () => {
    setBusy(true); setError(null); setIssues([]); setWarnings([]); setMsg(null); setSubmitted(false);
    try {
      const res = await api.validateElements(stationId, buildPayload());
      setIssues(res.errors);
      setWarnings(res.warnings);
      setMsg(res.errors.length === 0 ? `校验通过（${res.warnings.length} 条提示）` : `校验发现 ${res.errors.length} 个问题`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true); setError(null); setIssues([]); setWarnings([]); setMsg(null); setSubmitted(false);
    try {
      const res = await api.submitElements(stationId, buildPayload());
      setMsg(`提交成功：${res.element_count} 个要素，CT=${res.ct}s（v${res.version}）`);
      setWarnings(res.warnings ?? []);
      setSubmitted(true);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && (err.errors?.length ?? 0) > 0) {
        setIssues(err.errors!);
        setWarnings(err.warnings ?? []);
        setError(err.message);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const startRetest = async () => {
    // v3.19：空版本护栏的客户端预检（服务端同样校验，双保险）——当前版本无要素时复测无意义，
    // 且旧实现缺此护栏，"开始复测"被误点/测试点击会无限堆积空壳版本（L01-ST01 曾积到 v45）
    if ((loaded?.elements.length ?? 0) === 0) {
      setError(`当前版本 v${loaded?.station.version} 还没有任何要素，无需复测——直接在本版本继续分解即可`);
      return;
    }
    if (!window.confirm(`开始复测会把当前版本 v${loaded?.station.version}（${loaded?.elements.length} 条要素）封存为只读，并新建下一版本空白分解。继续？`)) return;
    setBusy(true); setError(null);
    try {
      const res = await api.startRetest(stationId);
      setMsg(`已封存 v${loaded?.station.version}，当前版本 v${res.version}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancelRetest = async () => {
    if (!window.confirm('作废复测会删除当前版本草稿并回退到上一版本。继续？')) return;
    setBusy(true); setError(null);
    try {
      const res = await api.cancelRetest(stationId);
      setMsg(`已作废复测，当前版本回退为 v${res.version}`);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * v3.45 手工分解线「AI自动识别浪费」（P0-4/P0-5，设计 D1/D6）：
   * submitted 态 → POST generate-manual（source=manual，与 AI 线端点/幂等/single-flight 完全隔离）。
   * 200：toast「识别完成：N 个浪费点 / M 条建议」+「前往浪费识别 →」链接；
   * 409：进行中提示 + 同链接；400：后端文案透传（无 manual 要素等）；其余：错误消息。
   * 焦点策略（v3.27 提交类动作）：finally blur 回 body，快捷键立即可用。
   */
  const runWasteAnalysis = async () => {
    setWasteBusy(true); setError(null); setMsg(null);
    try {
      const res = await api.aiWaste.generateManual(stationId);
      setMsg(`识别完成：${res.finding_count ?? res.findings?.length ?? 0} 个浪费点 / ${res.issue_count ?? res.issues?.length ?? 0} 条建议`);
      setWasteLink(`#/ai-waste/${stationId}?source=manual`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('已有识别任务进行中：请稍候到「浪费识别」页签查看');
        setWasteLink(`#/ai-waste/${stationId}?source=manual`);
      } else if (err instanceof ApiError && err.status === 400) {
        setError(err.message);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setWasteBusy(false);
      // 提交类动作焦点策略（v3.27）：焦点回 body，L/J/K/I/O 立即可用
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  };

  const pickVideo = (file: File | null | undefined) => {
    if (!file) return;
    // v3.28：留文件引用与 object URL——浏览器不能直播的格式（AVI/MKV/FLV/HEVC…）
    // 由 video onError 触发后端 ffmpeg 转码回退（每文件只试一次，防循环）
    pendingFileRef.current = file;
    serverTriedRef.current = false;
    setVideoConverting(null);
    // 新文件：清服务端派生轮询键、代理态、关键帧清单与上传进度（本地 object URL 无派生可言）
    setServerName(null);
    setProxyActive(false);
    setUploadPct(0);
    serverFpsRef.current = null;
    keyframesRef.current = [];
    setKeyframesSec([]);
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setVideoUrl(url);
    setVideoName(file.name);
    setPlayhead(0);
    setPlaying(false);
  };

  /**
   * v3.28 格式兼容回退：浏览器无法直播（MediaError 3=SRC_NOT_SUPPORTED / 4=DECODE_ERROR）→
   * 上传后端 ffmpeg 转码为 MP4（H.264+yuv420p+AAC+faststart）后继续播放。
   * 播放地址带 ?token=（video 标签发不了 Authorization 头，后端 file 端点回退查询参数鉴权）。
   * 失败走 error 横幅（v3.28 起三态有底色），明确告知原因与替代方案，不黑屏静默。
   */
  const convertOnServer = async (file: File) => {
    setVideoConverting(file.name);
    setUploadPct(0);
    setError(null);
    try {
      // SPEC-VID-P0 §7.1：≤8MB 单文件直传、>8MB 自动分片（规避 IIS 28.6MB 413 拦截）
      const res = await uploadVideo(file, { onProgress: setUploadPct });
      if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null; }
      pendingFileRef.current = null; // 已是服务端文件，后续播放错误不再回退
      setVideoUrl(videoFileUrl(res.name));
      setServerName(res.name); // 触发派生懒生成 + 5s 轮询（下方 effect）
      setVideoName(res.transcoded ? `${file.name} → MP4（已转换）` : `${file.name}（格式可直接播放）`);
      setVideoConverting(null);
      setMsg(`视频已就绪：${res.transcoded ? '服务器已转换为 MP4（H.264）' : '该格式浏览器可直接播放'}`);
    } catch (err) {
      setVideoConverting(null);
      setError(`视频转换失败：${(err as Error).message}`);
    }
  };

  /**
   * v3.28：access token 每 15min 静默刷新，服务端视频 URL 里的 ?token= 随之失效——
   * 监听刷新事件换 URL 并恢复播放位置，长视频跨 token 周期播放不断链。
   * 本地 object URL 不含 /videos/file/，自动跳过。
   * SPEC-VID-P0：分析代理 URL（/derivative/proxy?token=）同样只认查询参数令牌，一并换新。
   */
  useEffect(() => {
    const onRefresh = () => {
      const v = videoRef.current;
      if (!videoUrl || (!videoUrl.includes('/videos/file/') && !videoUrl.includes('/derivative/proxy'))) return;
      const resumeAt = v ? v.currentTime : 0;
      const resumePlay = v ? !v.paused : false;
      setVideoUrl((prev) => {
        if (!prev) return prev;
        if (prev.includes('/videos/file/')) {
          const name = prev.split('/videos/file/')[1]?.split('?')[0];
          return name ? videoFileUrl(name) : prev;
        }
        // 代理 URL：/api/videos/<uuid>.mp4/derivative/proxy?token=<old> → 换新 token
        const m = /\/videos\/([0-9a-f-]{36}\.mp4)\/derivative\/proxy/.exec(prev);
        return m ? videoDerivatives.fileUrl(m[1], 'proxy') : prev;
      });
      const restore = () => {
        if (v && resumeAt > 0) { try { v.currentTime = resumeAt; } catch { /* seek 失败忽略 */ } }
        if (resumePlay) void v?.play().catch(() => {});
        v?.removeEventListener('loadedmetadata', restore);
      };
      v?.addEventListener('loadedmetadata', restore);
    };
    window.addEventListener(AUTH_REFRESHED_EVENT, onRefresh);
    return () => window.removeEventListener(AUTH_REFRESHED_EVENT, onRefresh);
  }, [videoUrl]);

  /**
   * SPEC-VID-P0 §4/§5/§6：服务端派生懒生成 + 5s 轮询（复用 ai-task 轮询范式，进度不上 SSE）。
   * 载入服务端视频时自动触发一次 derive（幂等：ready 不重转；error 且 retry<2 由 worker 重入），
   * 之后轮询 derivatives：
   *  - index ready 且带 fps → 服务端 canonical fps 供数（决策 6；rVFC 采样让位）；
   *  - proxy ready → src 切代理 URL（all-intra，J/L 逐帧精确、无跨 GOP 抖动），保留播放头与播放态；
   *  - proxy error 且 retry≥2（终态）或 30min 兜底 → 停轮询，保持原始视频（§6 已定义降级行为）。
   * 无 station:read 权限等失败场景静默降级：派生是帧级精度的增强项，不阻断分解主流程。
   */
  useEffect(() => {
    if (!serverName) { setProxyActive(false); return; }
    let alive = true;
    let timer: number | null = null;
    let polls = 0;
    const POLL_MS = 5000;
    const POLL_MAX = 360; // 30min 兜底（worker retry<2 自动重入；终态 error 会提前停）
    const stop = () => { if (timer != null) { window.clearInterval(timer); timer = null; } };
    const findKind = (list: DerivativeMeta[], kind: string) => list.find((d) => d.kind === kind) ?? null;
    /** 切代理 src：保留当前播放头与播放态（与 token 刷新换 URL 同款恢复逻辑） */
    const switchToProxy = (url: string) => {
      const v = videoRef.current;
      const resumeAt = v ? v.currentTime : 0;
      const resumePlay = v ? !v.paused : false;
      setVideoUrl(url);
      const restore = () => {
        if (v && resumeAt > 0) { try { v.currentTime = resumeAt; } catch { /* seek 失败忽略 */ } }
        if (resumePlay) void v?.play().catch(() => {});
        v?.removeEventListener('loadedmetadata', restore);
      };
      v?.addEventListener('loadedmetadata', restore);
    };
    const poll = async () => {
      try {
        const list = await videoDerivatives.list(serverName);
        if (!alive) return;
        const idx = findKind(list, 'index');
        if (idx?.status === 'ready' && idx.fps && idx.fps > 0) {
          fpsSampled.current = true; // 服务端 canonical fps 优先，rVFC 不再覆盖
          serverFpsRef.current = idx.fps;
          setFps(idx.fps);
          // P0.5 关键帧清单：index ready 后单次拉 meta 载荷（keyframes 随 index.json 下发），
          // 只在尚未拿到时拉（避免每 5s 重复拉大数组）；载荷缺失/失败保持空 = 原 1/fps 网格
          if (!keyframesRef.current.length) {
            try {
              const m = await videoDerivatives.meta(serverName, 'index');
              if (!alive) return;
              const kf = (m.payload as { keyframes?: unknown } | undefined)?.keyframes;
              if (Array.isArray(kf) && kf.length > 0) {
                const sec = kf.map((v) => Number(v) / 1000).filter((n) => Number.isFinite(n) && n >= 0);
                keyframesRef.current = sec;
                setKeyframesSec(sec);
              }
            } catch { /* 载荷拉取失败静默：吸附回退 1/fps 网格 */ }
          }
        }
        const proxy = findKind(list, 'proxy');
        if (proxy?.status === 'ready') {
          stop();
          setProxyActive(true);
          switchToProxy(videoDerivatives.fileUrl(serverName, 'proxy'));
        } else if (proxy?.status === 'error' && proxy.retry >= 2) {
          stop(); // 终态错误：保持原始视频，不再空轮询
        } else if (proxy?.status === 'evicted') {
          // P0-1 磁盘治理 LRU 已淘汰代理（源视频保留）：按终态回落原视频，不空轮询。
          // 再次进入工作台时 derive 会把 evicted 重置为 pending，实现"按需重生成"。
          stop();
        }
      } catch { /* 轮询失败静默下一拍重试（增强项不阻断分解） */ }
      polls += 1;
      if (polls >= POLL_MAX) stop();
    };
    videoDerivatives.derive(serverName).catch(() => undefined); // 入队（幂等）
    void poll();
    timer = window.setInterval(poll, POLL_MS);
    return () => { alive = false; stop(); };
  }, [serverName]);

  /* 首次使用自动打开一次帮助（localStorage 一次性标记；页面仍零常驻提示） */
  useEffect(() => {
    if (!loaded) return;
    try {
      if (!localStorage.getItem('wb-help-seen')) {
        setShowHelp(true);
        localStorage.setItem('wb-help-seen', '1');
      }
    } catch { /* 隐私模式下静默跳过 */ }
  }, [loaded]);

  /* 描述联想：公司标准骨架（运行时规则发布版）+ 同线历史真实短语；真实短语优先，标准骨架补足冷启动 */
  const [descHints, setDescHints] = useState<string[]>([]);
  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    (async () => {
      try {
        const la = await api.lineAnalysis(loaded.station.line_id);
        const sibIds = la.rows.filter((r) => r.element_count > 0).slice(0, 5).map((r) => r.station_id);
        const lists = await Promise.all(sibIds.map((id) => api.elements(id).catch(() => ({ elements: [] as Element[] }))));
        const set = new Set<string>();
        for (const l of lists) {
          for (const el of (l as any).elements ?? []) {
            const d = String(el.desc ?? '').replace(/\[VA[^\]]*\]/g, '').trim();
            if (d && d.length <= 50) set.add(d);
          }
        }
        for (const d of draft) if (d.desc) set.add(d.desc);
        if (alive) setDescHints([...set].slice(0, 200));
      } catch { /* 联想是增强不是依赖，静默失败 */ }
    })();
    return () => { alive = false; };
  }, [loaded?.station.station_id]);
  const allDescHints = useMemo(() => {
    const set = new Set(descHints);
    for (const entry of motionStd.entries) {
      const hint = motionFormatHint(entry);
      if (hint) set.add(hint);
    }
    return [...set].slice(0, 200);
  }, [descHints, motionStd]);

  /* 复用弹窗打开时，拉同线工位清单（含要素数）作为来源选项 */
  useEffect(() => {
    if (!showReuse || !loaded) return;
    let alive = true;
    api.lineAnalysis(loaded.station.line_id)
      .then((la) => {
        if (!alive) return;
        setSiblings(la.rows
          .filter((r) => r.station_id !== loaded.station.station_id && r.element_count > 0)
          .map((r) => ({ station_id: r.station_id, name: r.name, element_count: r.element_count })));
      })
      .catch(() => { if (alive) setSiblings([]); });
    return () => { alive = false; };
  }, [showReuse, loaded]);

  /**
   * 复用要素结构（跨循环 / 跨工位）：把来源要素按当前播放头（追加）或从 0（替换）铺进草稿。
   * 典型场景：同一工位第 2 个循环、同一线相似工位、复测沿用上一版结构。
   */
  const applyReuse = async (src: { kind: 'prev'; version: number; count: number } | { kind: 'station'; stationId: string; name: string }) => {
    if (!loaded) return;
    if (reuseMode === 'replace' && draft.length > 0 && !window.confirm(`将用来源的要素替换当前 ${draft.length} 条要素，继续？`)) return;
    setSubmitted(false); // v3.45 草稿脏检查（P1-1）：复用铺入草稿即变更
    setReuseBusy(true); setError(null);
    try {
      const res = src.kind === 'prev'
        ? await api.elements(loaded.station.station_id, src.version)
        : await api.elements(src.stationId);
      const els = res.elements ?? [];
      if (els.length === 0) { setError('该来源没有可复用的要素'); return; }
      const base = reuseMode === 'append' ? Math.round(playhead) : 0;
      const converted: Draft[] = els.map((el, i) => ({
        key: `reuse-${Date.now()}-${i}`,
        seq: i + 1,
        /* v3.29：起点取整（与 INT 列一致）、时长网格化（与 DECIMAL(10,2) 一致） */
        start_ms: base + Math.round(Number(el.start_ms)),
        dur_s: durToGrid(Number(el.dur_s)),
        hand: (el.hand as Draft['hand']) ?? 'R',
        type: el.type,
        desc: el.desc,
        va_class: el.va_class,
        va_reason: '',
        outlier_flag: Number(el.outlier_flag) === 1 ? 1 : 0,
        outlier_reason: el.outlier_reason ?? '',
        // 评比/宽放默认不随结构复制：跨工位沿用会造成 ST 虚假一致（工时专家会审 P1-2）
        rating: reuseCopyRating ? Number(el.rating) || 1 : 1,
        allowance: reuseCopyRating ? Number(el.allowance) || 0.15 : 0.15,
        // 复制了评比宽放才算已评定；否则落"未评定"，逼复用后按本工位重新评定
        rated: reuseCopyRating ? ('hand' as const) : undefined,
      }));
      const merged = [...(reuseMode === 'append' ? draft : []), ...converted].sort((a, b) => a.start_ms - b.start_ms);
      merged.forEach((d, i) => { d.seq = i + 1; });
      setDraft(merged);
      setSelected(merged[0]?.key ?? null);
      setShowReuse(false);
      setFlash(`已复用 ${converted.length} 条要素（${reuseMode === 'append' ? '从播放头追加' : '替换全部'}${reuseCopyRating ? '' : '，评比/宽放未复制'}` + '）');
      setTimeout(() => setFlash(null), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReuseBusy(false);
    }
  };

  const rulerTicks = useMemo(() => {
    const step = totalMs > 60000 ? 5000 : 1000;
    const ticks: number[] = [];
    for (let ms = 0; ms <= totalMs; ms += step) ticks.push(ms);
    return ticks;
  }, [totalMs]);

  if (!loaded) {
    return <div className="card empty">{error ?? '加载中…'}</div>;
  }

  /** 快捷工具箱动作清单（v3.20）：全部复用既有 handler，不新增业务路径。
   *  排序即推荐路径：录入加速（最高频）→ 播放与帧 → 要素结构 → 评定与交付。
   *  disabled 语义与界面按钮一致（无选中/无草稿时置灰，回车不执行）。 */
  const toolActions: ToolAction[] = [
    // —— 录入加速（高频）——
    { id: 'commit', group: '录入加速', label: '完成·下一个', hint: '记录本条并跳到下一要素', kbd: 'Ctrl+↵', run: commitAndNext, disabled: !canWrite },
    { id: 'add', group: '录入加速', label: '新增要素', hint: '紧接前一要素止点生成连续片段（编号=最大+1）', kbd: 'N', run: () => addElement(), disabled: !canWrite },
    { id: 'add-same', group: '录入加速', label: '同上新增', hint: '沿用末条属性（重复动作免重设），片段仍拼接连续', kbd: 'D', run: addSameAsLast, disabled: !canWrite },
    { id: 'sd-clear', group: '录入加速', label: '清空结构化字段草稿', hint: '清掉跨要素延续的描述/行程草稿', run: () => { setSdValues({}); setSdReach(''); } },
    { id: 'hand-l', group: '录入加速', label: '手别：左手', hint: '选定后新要素沿用', kbd: '1', run: () => setHandOfSelected('L'), disabled: !selected || !canWrite },
    { id: 'hand-r', group: '录入加速', label: '手别：右手', kbd: '2', run: () => setHandOfSelected('R'), disabled: !selected || !canWrite },
    { id: 'hand-b', group: '录入加速', label: '手别：双手', hint: '左右手同时完成的合并口径', kbd: '3', run: () => setHandOfSelected('B'), disabled: !selected || !canWrite },
    // —— 播放与帧 ——
    { id: 'play', group: '播放与帧', label: '播放 / 暂停', hint: '选中要素时 = 片段播放（默认单次）', kbd: 'Space', run: togglePlay },
    { id: 'shuttle-f', group: '播放与帧', label: '按住 L 前进播放', hint: '连续正放（不受片段止点拦截），松开即停；变速用倍率按钮', kbd: 'L', run: () => undefined, disabled: true },
    { id: 'shuttle-b', group: '播放与帧', label: '按住 J 倒放', hint: '按帧回退（受倍率控制）；Shift+J = 后退 10 帧', kbd: 'J', run: () => jShuttleStart(), disabled: false },
    { id: 'pause', group: '播放与帧', label: 'K 播放 / 暂停', hint: '暂停时从当前播放头连续正放；播放时暂停并帧对齐', kbd: 'K', run: toggleContinuousPlay },
    { id: 'slow', group: '播放与帧', label: '减速', kbd: '−', run: () => stepSpeed(-1) },
    { id: 'fast', group: '播放与帧', label: '加速', kbd: '+', run: () => stepSpeed(1) },
    { id: 'set-start', group: '播放与帧', label: '设起点', hint: '选中要素起点移到播放头（先 ←→ 逐帧对准）', kbd: 'I', run: setStartAtPlayhead, disabled: !selected || !canWrite },
    { id: 'set-end', group: '播放与帧', label: '设止点', hint: '选中要素止点移到播放头', kbd: 'O', run: setEndAtPlayhead, disabled: !selected || !canWrite },
    { id: 'trim-s-', group: '播放与帧', label: '起点 −1 帧', hint: 'Shift = 10 帧；拖拽只适合粗调', kbd: ',', run: () => nudgeEdge('start', -1, 1), disabled: !selected || !canWrite },
    { id: 'trim-s+', group: '播放与帧', label: '起点 +1 帧', kbd: '.', run: () => nudgeEdge('start', 1, 1), disabled: !selected || !canWrite },
    { id: 'trim-e-', group: '播放与帧', label: '止点 −1 帧', kbd: '[', run: () => nudgeEdge('end', -1, 1), disabled: !selected || !canWrite },
    { id: 'trim-e+', group: '播放与帧', label: '止点 +1 帧', kbd: ']', run: () => nudgeEdge('end', 1, 1), disabled: !selected || !canWrite },
    { id: 'fullscreen', group: '播放与帧', label: '全屏工作台', hint: '再按一次退出', kbd: 'F', run: () => void toggleFullscreen() },
    // —— 要素结构 ——
    { id: 'split', group: '要素结构', label: '播放头分割', hint: '在播放头处切分要素（自动定位）', kbd: 'S', run: () => splitAtPlayhead(), disabled: !canWrite },
    { id: 'del', group: '要素结构', label: '删除选中要素', hint: '30 秒内可撤销', kbd: 'Del', run: () => selected && deleteElement(selected), disabled: !selected || !canWrite },
    { id: 'undo-del', group: '要素结构', label: '撤销删除', run: undoDelete, disabled: !lastDeleted },
    { id: 'clear-all', group: '要素结构', label: `一键清空草稿（${draft.length} 条）`, hint: '清空未提交要素重新开始（二次确认）', run: clearAll, disabled: draft.length === 0 || !canWrite },
    // —— 评定与交付 ——
    { id: 'batch', group: '评定与交付', label: '批量评定', hint: '按循环整体表现统一选档', run: () => setShowBatch(true), disabled: !canWrite },
    { id: 'reuse', group: '评定与交付', label: '复用要素', hint: '从历史版本/同线工位套用结构', run: () => setShowReuse(true), disabled: !canWrite },
    { id: 'submit', group: '评定与交付', label: '提交分解', hint: '本地草稿 → 正式 ST（可返工）', run: () => void submit(), disabled: busy },
    { id: 'waste', group: '评定与交付', label: 'AI 识别浪费', hint: '基于已提交的手工分解要素生成待审问题清单（与顶栏按钮同函数，禁用态一致）', run: () => void runWasteAnalysis(), disabled: !can('suggestion:generate') || draftDirty || !hasCommitted || busy || wasteBusy },
    { id: 'retest', group: '评定与交付', label: '开始复测', hint: '封存当前版本并开新版', run: () => void startRetest(), disabled: busy },
    { id: 'help', group: '评定与交付', label: '快捷键帮助', kbd: '?', run: () => setShowHelp(true) },
  ];

  const sealed = loaded.versions.filter((v) => v.is_sealed && v.element_count > 0);
  /** v3.19 有效版本 = 有要素的版本 + 当前版本；空壳版本（开始复测但未提交要素）不计入展示与对比。
   *  历史教训：L01-ST01 曾被误点/测试点击堆积到 v45，而只有 v1 有要素——全量平铺既无意义又吓人。
   *  （服务端已加空版本护栏，此处同时治理存量展示。） */
  const effVersions = loaded.versions.filter((v) => v.element_count > 0 || v.is_current);
  const emptyVerCount = loaded.versions.length - effVersions.length;
  /** 可复用的历史版本（曾经的循环/复测结构） */
  const prevVersions = loaded.versions.filter((v) => v.version < loaded.station.version && v.element_count > 0).sort((a, b) => b.version - a.version);
  const tt = loaded.station.tt;
  const overTt = tt != null && stats.ct > tt;
  const frameNo = Math.round(playhead / frameMs);
  const v3ok = cycles >= 15 && !(cv > 0.15 && cycles < 25);
  /** 交付条唯一引导语（固定高度条内单行）：优先级 循环不足 > CV 波动 > 未评定 > 双手占比；null=无提示（条仍占位，高度不变） */
  const abHint: { text: string; level: 'warn' | 'info'; title?: string } | null =
    cycles < 15
      ? { text: '循环不到 15 个，均值不稳，继续测', level: 'warn', title: 'V3 门槛：循环≥15；CV>0.15 时须≥25' }
      : cycles >= 15 && cv > 0.15 && cycles < 25
        ? { text: `CV=${cv.toFixed(2)} 波动偏大，作业不稳，测到 25 个以上`, level: 'warn', title: 'V3 门槛：循环≥15；CV>0.15 时须≥25' }
        : cycles >= 25 && cv > 0.15
          ? { text: '循环够了但波动大，查下异常原因再交', level: 'info' }
          : unratedCount > 0
            ? { text: `评定完整性：${unratedCount}/${draft.length} 要素未评定`, level: 'warn', title: '软提示：不拦提交；用检查器顶部「批量评定」按循环整体表现选档' }
            : draft.length >= 5 && handCount.B / draft.length > 0.7 && handCount.L === 0 && handCount.R === 0
              ? { text: '全部要素记为"双手"：如需左右手分工分析（双手图），请按实际分手改 L/R', level: 'info', title: '双手 B = 左右手同时完成同一动作的合并口径；双手图与单手平衡分析按 L/R 配对，全 B 时无法拆手' }
              : null;

  return (
    <div ref={wbRef}
      style={{
        ['--wb-ar' as any]: videoAr,
        ['--wb-stage-w' as any]: stageW ? `${stageW}px` : undefined,
      }}
      className={`wb${isFull ? ' wb-full' : ''}${tlOpen ? '' : ' tl-closed'}`}>
      {/* v3.61：AI 调用全局横幅（统一反馈件；portal 挂 body）。结果 toast 走既有 msg/error 通道 */}
      <AiCallBanner active={wasteBusy} label="正在执行 AI 浪费识别" phase="LLM 生成中，通常需要数十秒" />
      {/* 顶栏（单行紧凑菜单栏 ≈40px）：身份 + 本地即时指标 + 全部配置/切换动作。
          桌面应用式顶栏——菜单内容都在这一行，不额外占竖向高度；快捷键入口仅 ? 浮层 */}
      <header className="wb-topbar no-print">
        <div className="wb-id">
          <h1>{loaded.station.name}</h1>
          <div className="wb-meta mono">
            {loaded.station.station_id} <i>·</i> v{loaded.station.version} <i>·</i>{' '}
            {effVersions.length >= 2 ? (
              <a href={`#/diff/${loaded.station.station_id}/${effVersions[effVersions.length - 2].version}/${loaded.station.version}`}
                title={`版本 Diff：相邻两版要素结构逐条比对（有效版本 ${effVersions.length} 个${emptyVerCount > 0 ? `，另有 ${emptyVerCount} 个空版本未计入` : ''}）`}>{effVersions.length} 个有效版本 ⤫</a>
            ) : (
              <>{effVersions.length === 1 ? '首个版本' : `${loaded.versions.length} 个版本`}</>
            )}{' '}
            <i>·</i> {loaded.station.line_id}
          </div>
        </div>
        <div className="wb-stats">
          <div className="ws"><b>{draft.length}</b><span>要素</span></div>
          <div className={`ws${overTt ? ' bad' : ''}`} title={unratedCount > 0 ? '含未评定要素，按默认 1.00/0.15 预估' : undefined}>
            <b>{stats.ct.toFixed(2)}{unratedCount > 0 ? <i className="ct-star">*</i> : ''}<i>s</i></b><span>预览 CT{unratedCount > 0 ? ' · 含未评定' : ''}</span>
          </div>
          <div className="ws"><b>{tt ?? '—'}<i>{tt != null ? 's' : ''}</i></b><span>TT</span></div>
          <div className="ws"><b>{stats.vaPct}<i>%</i></b><span>VA 占比</span></div>
          {stats.outliers > 0 && <div className="ws warn"><b>{stats.outliers}</b><span>异常</span></div>}
        </div>
        <div className="wb-top-acts">
          <span className="wb-vfile mono" title={videoName ?? undefined}>{videoName ?? '未载入视频'}</span>
          {canWrite && (
            <button className="wb-top-btn" onClick={() => setShowReuse(true)} title="从上一版本或同线其他工位复用要素结构（跨循环）">
              复用要素
            </button>
          )}
          {/* v3.45 手工分解线入口（P0-4）；v3.48 门控精确化：脏草稿/无已提交要素/忙碌/分析中置灰
              （title 说明原因——fresh load 后 draft≡committed 不脏，按钮可点） */}
          {can('suggestion:generate') && (
            <button className="wb-top-btn" onClick={() => void runWasteAnalysis()}
              disabled={draftDirty || !hasCommitted || busy || wasteBusy}
              title={draftDirty
                ? '分解有未提交修改：先「提交分解」后再识别（AI 基于已提交要素）'
                : !hasCommitted
                  ? '当前版本还没有已提交要素：先在监看区记录动作并提交分解'
                  : 'AI 自动识别浪费：基于已提交的手工分解要素生成待审问题清单'}>
              {wasteBusy ? '分析中…' : 'AI自动识别浪费'}
            </button>
          )}
          <label className="wb-top-btn" title="选择本地视频文件（MP4/MOV/WebM 浏览器直接播放；AVI/MKV/FLV 等自动转码）">
            {videoUrl ? '更换视频' : '载入视频'}
            <input type="file" accept={VIDEO_ACCEPT} onChange={(e) => { pickVideo(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <button className="wb-top-btn icon" onClick={() => setToolboxOpen(true)} title="快捷工具箱（Ctrl+K）——全部操作一处唤起，输入即过滤" aria-label="快捷工具箱"><IconToolbox /></button>
          <button className="wb-top-btn icon" onClick={() => setShowHelp(true)} title="键盘快捷键" aria-label="键盘快捷键">?</button>
          <button className="wb-top-btn icon" onClick={() => void toggleFullscreen()}
            title={isFull ? '退出全屏（Esc / F）' : '全屏工作台（F）——视频、检查器、时间线一起放大'}
            aria-label="全屏切换">{isFull ? '⤡' : '⤢'}</button>
        </div>
      </header>

      {/* 瞬时提示一律浮层（flash/撤销/校验结果）：不占文档流，加要素、出提示都不再改变监看区高度 */}
      {flash && <div className="wb-toast wb-toast-flash">{flash}</div>}
      {lastDeleted && (
        <div className="wb-toast wb-toast-undo">
          已删除 #{lastDeleted.item.seq} {lastDeleted.item.desc}
          <button className="btn sm" onClick={undoDelete}>撤销（30 秒内）</button>
          <button className="wb-undo-x" onClick={() => setLastDeleted(null)} aria-label="关闭">×</button>
        </div>
      )}

      {(error || msg || issues.length > 0 || warnings.length > 0) && (
        <div className="wb-toast wb-toast-banners">
          {error && (
            <AutoBanner key={error} kind="error" ms={10000} onClose={() => { setError(null); setWasteLink(null); }}>{error}
              {wasteLink && <a href={wasteLink} className="wb-inline-link">前往浪费识别 →</a>}
            </AutoBanner>
          )}
          {msg && (
            <AutoBanner key={msg} kind="success" ms={6000} onClose={() => { setMsg(null); setWasteLink(null); }}>
              {msg}
              {submitted && <a href={`#/analysis/${loaded.station.station_id}`} className="wb-inline-link">查看分析结果 →</a>}
              {wasteLink && <a href={wasteLink} className="wb-inline-link">前往浪费识别 →</a>}
            </AutoBanner>
          )}
          {issues.length > 0 && (
            <AutoBanner key={issues.map((i) => i.code).join(',')} kind="error" ms={12000} onClose={() => setIssues([])}>
              {issues.map((issue, index) => <div key={index}>[{issue.code}] {issue.message}</div>)}
            </AutoBanner>
          )}
          {warnings.length > 0 && (
            <AutoBanner key={warnings.map((w) => w.code).join(',')} kind="warn" ms={10000} onClose={() => setWarnings([])}>
              {warnings.map((warning, index) => <div key={index}>[{warning.code}] {warning.message}</div>)}
            </AutoBanner>
          )}
        </div>
      )}

      {/* 主区：监看区（左列，吃满剩余空间）｜属性检查器（右列，常驻内部滚动）。
          两者同屏并存——填属性与看/拖时间线不再来回切换 */}
      <div className={`wb-main${inspectorCollapsed ? ' inspector-collapsed' : ''}`} ref={mainRef}>
        {/* 检查器折叠态：常驻悬浮展开入口（v3.19）。展开态的"收起"按钮在检查器内顶部，
            两者同一动作、两态各只有一个可见——不会出现"收起来就找不到"的死角 */}
        {inspectorCollapsed && (
          <button type="button" className="wb-insp-show" onClick={() => setInspectorCollapsed(false)}
            title="展开属性检查器（此前收起后只能靠新增要素间接恢复，v3.19 起常驻此入口）">
            ◀ 显示检查器
          </button>
        )}
        {/* 监看区：深色舞台，视频画面按实测容器取最大等比帧 */}
        <section className={`wb-stage${playing ? ' live' : ''}`}>
          <div className="wb-screen" ref={screenRef}>
            {selectedElement && playing && (
              <button type="button" className="wb-seg-chip"
                onClick={() => setSelected(null)}
                title={segLoop
                  ? '片段循环播放中：起点→止点反复播放；点击取消选中，恢复全片播放（Esc 同效）'
                  : '片段播放中：起点→止点播完即停（单次）；点击取消选中，恢复全片播放（Esc 同效）'}>
                {segLoop ? `片段 #${selectedElement.seq} 循环 ↻` : `片段 #${selectedElement.seq} 单次 ▶`}
              </button>
            )}
            {videoUrl ? (
              <div className="wb-frame" style={videoBox ? { width: videoBox.w, height: videoBox.h } : undefined}>
              <video
                ref={videoRef}
                src={videoUrl}
                tabIndex={-1}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={onVideoTime}
                onError={(e) => {
                  // v3.28 格式兼容回退：仅 SRC_NOT_SUPPORTED(3)/DECODE_ERROR(4) 走后端 ffmpeg 转码，
                  // 每文件只试一次（serverTriedRef 防循环）；其余错误明确提示，不黑屏静默
                  const v = e.currentTarget;
                  const code = v.error?.code;
                  if ((code === 3 || code === 4) && pendingFileRef.current && !serverTriedRef.current) {
                    serverTriedRef.current = true;
                    void convertOnServer(pendingFileRef.current);
                  } else if (code) {
                    setError(`视频加载失败（${v.error?.message || '未知错误'}）——可尝试转换为 MP4(H.264+AAC) 后重试`);
                  }
                }}
                onLoadedMetadata={(e) => {
                  const v = e.currentTarget;
                  if (v.videoWidth > 0 && v.videoHeight > 0) setVideoAr(v.videoWidth / v.videoHeight);
                }}
                onClick={togglePlay}
              />
              </div>
            ) : (
              <button className="wb-drop" type="button" onClick={() => fileRef.current?.click()}>
                <span className="wb-drop-ico" aria-hidden>▶</span>
                <span className="wb-drop-t">载入工位视频开始分解</span>
                <span className="wb-drop-d">MP4/MOV/WebM 浏览器直接播放 · AVI/MKV/FLV 等自动转码 · 建议 30fps 以上、固定机位</span>
                <span className="wb-drop-k">点击选择文件</span>
              </button>
            )}
            {videoConverting && (
              <div className="wb-converting" role="status">
                <span className="wb-converting-spin" aria-hidden="true">◌</span>
                <div className="wb-converting-txt">
                  <div className="wb-converting-t">正在服务器转换视频格式…</div>
                  <div className="wb-converting-d">
                    {videoConverting} —— 该格式浏览器不能直接播放，转码为 MP4(H.264) 后自动继续；大文件可能需要几十秒到几分钟{uploadPct > 0 && uploadPct < 100 ? `（上传 ${uploadPct}%）` : ''}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 单条控制栏：传输（播放/帧进/时间码/速度）与记录（分割/新增/同上）合并为一行，
              比旧的三条工具条少占约 46px 竖向空间——全部让给视频画面 */}
          <div className="wb-controls">
            <button className="wb-play" onClick={togglePlay} title={playing ? '暂停（K）' : (selectedElement ? `播放片段 #${selectedElement.seq}（${segLoop ? '循环' : '单次，播完即停'}；Esc / 再点一次该块取消）` : '播放（Space；K 为播放/暂停，按住 L 为连续正放）')} aria-label={playing ? '暂停' : '播放'}>              {playing ? <IconPause /> : <IconPlay />}
            </button>
            <div className="wb-tp-group">
              <button className="wb-tp-btn" title={`后退一帧（${frameMs.toFixed(1)}ms @ ${fps}fps）`} aria-label="后退一帧"
                onClick={() => stepFrameBy(-1)}><IconPrevFrame /></button>
              <button className="wb-tp-btn" title={`前进一帧（${frameMs.toFixed(1)}ms @ ${fps}fps）`} aria-label="前进一帧"
                onClick={() => stepFrameBy(1)}><IconNextFrame /></button>
              <button className="wb-tp-btn sm" title="后退 1 秒" onClick={() => seek(Math.max(0, playhead - 1000))}>−1s</button>
              <button className="wb-tp-btn sm" title="前进 1 秒" onClick={() => seek(playhead + 1000)}>+1s</button>
              {/* v3.23：−1s/+1s 保留（粗跳）；↑↓ 边界按钮取消（时间线点选/拖拽已覆盖，键盘 ↑↓ 仍在）——
                  控制栏宽度让给记录动作组，＋新增 不再被挤到裁切区 */}
            </div>
            <div className="wb-tp-time mono" title={`播放头位置 · 步长 ${frameMs.toFixed(1)}ms/帧（按视频实测 ${fps}fps）`}>
              <b>{fmtTime(playhead)}</b><span>f{frameNo}</span><span className={`wb-fps${fps < 30 ? ' low' : ''}`} title={`步长 ${frameMs.toFixed(1)}ms/帧（按视频实测 ${fps}fps）`}>{fps}fps</span>
              {/* v3.23：「帧率不足 30」长文案取消——fps 徽标低于 30 已变琥珀色，重复提示挤占记录按钮空间 */}
            </div>
            <div className="wb-tp-speed" role="group" aria-label="播放速度">
              {SPEED_STEPS.map((s) => (
                <button key={s} type="button" className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)} title={`${s} 倍速`}>{s}×</button>
              ))}
              {/* 片段循环开关（v3.22）：与倍率同行——选中要素播放默认单次（播完即停），
                  核对边界需要反复看时再开循环 */}
              <button type="button" className={`wb-loop-btn${segLoop ? ' on' : ''}`}
                onClick={() => setSegLoop((v) => !v)}
                title={segLoop ? '片段循环：开（选中要素播放到止点后回到起点反复播）——点击改回单次'
                            : '片段循环：关（选中要素播放到止点即停，单次）——点击开启循环'}
                aria-pressed={segLoop}>
                ↻ 循环{segLoop ? '开' : '关'}
              </button>
            </div>
            {canWrite && (
              <div className="wb-rec">
                {/* v3.23 重要性排序：＋新增（最高频入口 N）→ I/O 精修起止点 → 分割 → 同上（便利复制）；
                    此前 ＋新增 排第 4，窄舞台被 overflow 裁切到几乎不可见 */}
                <button className="wb-rec-btn" onClick={() => addElement()} title="新增要素：紧接前一要素止点生成连续片段，编号=最大编号+1（快捷键 N）">＋<span className="lbl">新增</span></button>
                {/* 起止点快捷标记（剪辑软件 I/O 惯例）：逐帧对准播放头后一键落边界，修正误标不拖块 */}
                <button className="wb-rec-btn io" onClick={setStartAtPlayhead}
                  title="设起点：把选中要素的起点移到播放头（快捷键 I）——先用 ←→ 逐帧对准，再按 I 即修正；也可用 , / . 按帧拧">
                  <span className="io-k">I</span><span className="lbl">起点</span>
                </button>
                <button className="wb-rec-btn io" onClick={setEndAtPlayhead}
                  title="设止点：把选中要素的止点移到播放头（快捷键 O）——先用 ←→ 逐帧对准，再按 O 即修正；也可用 [ / ] 按帧拧">
                  <span className="io-k">O</span><span className="lbl">止点</span>
                </button>
                <button className="wb-rec-split" onClick={() => splitAtPlayhead()} title="在播放头分割要素（快捷键 S）">
                  <IconSplit /><span className="lbl">分割</span>
                </button>
                <button className="wb-rec-btn" onClick={addSameAsLast} title="同上新增：复制末要素类型与工时参数">⧉<span className="lbl">同上</span></button>
              </div>
            )}
          </div>
        </section>

        {/* 属性检查器：常驻右列、独立滚动，不随页面上下滚动；与时间线条同屏并存 */}
        <aside className={`wb-inspector${inspectorCollapsed ? ' collapsed' : ''}`}>
          {/* 检查器折叠/展开切换按钮 */}
          <div className="wb-insp-toggle-row">
            <button type="button" className="wb-insp-toggle-btn" onClick={() => setInspectorCollapsed((v) => !v)}
              title={inspectorCollapsed ? '展开属性检查器' : '收起检查器（视频全宽）'}>
              {inspectorCollapsed ? '◀ 显示检查器' : '▶ 收起'}
            </button>
          </div>

              {/* 批量评定（会审 P0-1）：按"操作者×循环"集中评定——工位级动作，未选中要素时常驻可见 */}
              <div className={`wb-batch${showBatch ? ' open' : ''}`}>
                <button type="button" className="wb-batch-sum" onClick={() => setShowBatch((v) => !v)}
                  title={showBatch ? '收起批量评定' : '展开批量评定：按循环整体表现选档，不用逐个评'}>
                  <span className="wb-batch-sum-t">批量评定</span>
                  {unratedCount > 0 ? (
                    <span className="wb-batch-sum-v warn">还没评定：{unratedCount} 个要素全用默认 1.00/0.15</span>
                  ) : (
                    <span className="wb-batch-sum-v">
                      {batchCount > 0 ? `${batchRating.toFixed(2)} / ${Math.round(batchAllowance * 100)}% · 批量 ${batchCount} 个` : '已逐要素评定'}
                      {handRatedCount > 0 ? ` · 手改 ${handRatedCount} 个` : ''} · 点此修改
                    </span>
                  )}
                  <span className="wb-batch-caret">{showBatch ? '▴' : '▾'}</span>
                </button>
                {showBatch && (
                  <div className="wb-batch-body">
                    <p className="wb-batch-tip">选一个中间循环完整看一遍，按整体表现选档，不用逐个评；个别要素不一样，回上方单独改。</p>
                    <div className="wb-batch-t">评比系数（西屋法四因子简化五档）</div>
                    <div className="wb-batch-tiers">
                      {RATING_TIERS.map((t) => (
                        <button key={t.v} type="button" className={`wb-tier${batchRating === t.v ? ' on' : ''}`}
                          onClick={() => setBatchRating(t.v)} title={t.hint}>
                          <b>{t.v.toFixed(2)}</b><span>{t.label}</span>
                        </button>
                      ))}
                    </div>
                    <label className="wb-batch-custom" title="限 0.70~1.25；超 1.10 先查方法/治具是否不同——那是改善点，不是系数">
                      <span>自定义</span>
                      <input type="number" step="0.01" min={0.7} max={1.25} value={batchRating}
                        onChange={(e) => setBatchRating(Math.min(1.25, Math.max(0.7, Number(e.target.value) || 1)))} />
                      {batchRating > 1.10 && <em className="warn">超 1.10 先查方法/治具是否不同</em>}
                    </label>
                    <div className="wb-batch-t">宽放率（生理+疲劳+事务合并四档）</div>
                    <div className="wb-batch-tiers">
                      {ALLOWANCE_TIERS.map((t) => (
                        <button key={t.v} type="button" className={`wb-tier${batchAllowance === t.v ? ' on' : ''}`}
                          onClick={() => setBatchAllowance(t.v)} title={t.hint}>
                          <b>{Math.round(t.v * 100)}%</b><span>{t.label}</span>
                        </button>
                      ))}
                    </div>
                    <div className="wb-batch-t">应用范围</div>
                    <div className="wb-batch-scope">
                      <label><input type="radio" checked={batchScope === 'unrated'} onChange={() => setBatchScope('unrated')} />
                        没动过的要素（{unratedCount} 个）</label>
                      <label className="disabled" title="逐要素手改的值也会被覆盖，应用前会确认"><input type="radio" checked={batchScope === 'all'} onChange={() => setBatchScope('all')} />
                        全部要素（{draft.length} 个）</label>
                    </div>
                    {batchOverwrite && (
                      <div className="wb-batch-warn">
                        将覆盖 {handRatedCount} 个已手工评定的值
                        <button type="button" className="btn sm" onClick={applyBatch}>覆盖</button>
                        <button type="button" className="btn sm ghost" onClick={() => { setBatchScope('unrated'); applyBatch(); }}>只填没评过的</button>
                      </div>
                    )}
                    <div className="wb-batch-foot">
                      <span>ST = 时长 × 评比 × (1+宽放)；取值优先级：手改 &gt; 批量 &gt; 默认 1.00/0.15</span>
                      <button type="button" className="btn sm primary" onClick={applyBatch} disabled={batchScope === 'unrated' && unratedCount === 0}>
                        应用（{batchScope === 'all' ? draft.length : unratedCount} 个）
                      </button>
                    </div>
                  </div>
                )}
              </div>
          {selectedElement ? (
            <>
              <div className="wb-insp-head">
                <span className="wb-insp-seq mono">#{selectedElement.seq}</span>
                {/* 标题=描述框：结构化字段组合后自动写入此处（预览已取消，同内容不多处显示） */}
                <input
                  ref={descRef}
                  className="wb-desc"
                  list="wb-desc-hints"
                  value={selectedElement.desc}
                  onChange={(e) => update(selectedElement.key, { desc: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); commitAndNext(); }
                  }}
                  placeholder="动作描述（回车 = 完成并下一个）"
                  maxLength={50}
                />
                <button className="wb-icon" title="在播放头分割该要素" aria-label="分割" onClick={() => splitAtPlayhead(selectedElement.key)}><IconSplit /></button>
                <button className="wb-icon danger" title="删除该要素（30 秒内可撤销）" aria-label="删除" onClick={() => deleteElement(selectedElement.key)}><IconTrash /></button>
              </div>

              {/* 结构化描述（v3.18）：按描述语序布置——动作要素（句首动词）→ 对象 → 位置 → 行程，
                  全部收在「结构化描述」小节内、紧挨标题行，比旧版（类型在头部行）更紧凑。
                  字段集合由所选类型的「描述格式」动态决定：拿取 → 对象·于·位置·距离（+行程部位）；
                  目检 → 对象·属性；转身 → 角度；弯腰 → 对象·程度；走动 → 步数。
                  选择/填写后自动写入上方描述框（标题处）；手改描述 / 改判标记永远优先，自动同步即停。
                  填写提示见《动作标准与填写说明》文档，不在界面内堆叠 */}
              <div className="wb-sec">
                <div className="wb-sec-t">结构化描述<span className="wb-sec-t-sub">{sdEntry?.format ? '按标准格式自动写入' : '该类型无标准格式（描述手写）'}</span></div>
                <div className="wb-sd">
                  <div className="wb-field wb-sd-type">
                    <span>动作要素</span>
                    <TypeSelect
                      value={selectedElement.type}
                      groups={motionStd.groups}
                      classicOptions={THERBLIG_GROUPS.flatMap((g) => g.types).filter((t) => !motionStd.byType[t]).concat('其他')}
                      byType={motionStd.byType}
                      onOpenChange={(o) => { typeMenuOpenRef.current = o; }}
                      onFocusChange={(f) => { typeBtnFocusRef.current = f; }}
                      onChange={(type) => {
                        // 类型变更 = 动作变化 → VA 类别按标准默认自动重判；旧改判标记随之失效，剥离避免陈旧备注。
                        // v3.26 对象继承预填（IE 专家团映射表）：字段草稿不整体复制——按「上一动作→本动作」
                        // 判定是否带入上一要素的对象（yes 静默 / conditional 带「请确认」/ no 留空），
                        // 位置/距离/属性等其余字段一律清空（多数情况下下一动作的位置参数不可复用）。
                        const prevEl = prevElementOf(selectedElement.key);
                        const { vals, hint } = carrySdFor(prevEl, type);
                        setSdValues(vals);
                        setSdReach('');
                        setCarryHint(hint ? { key: selectedElement.key, msg: hint } : null);
                        // 新循环断点（专家总则②）：下一为拿取/握取，或上一条为放置/放手 → 轻提示，防呆不错填
                        if (prevEl && isNewCycleBreak(prevEl.type, type)) {
                          setFlash('新对象/新循环？已从空白开始录入');
                          setTimeout(() => setFlash(null), 2000);
                        }
                        update(selectedElement.key, {
                          type,
                          va_class: typeDefaultOf(type),
                          va_reason: '',
                          desc: stripVaMarker(selectedElement.desc),
                        });
                      }}
                      onManual={(verb, rest) => {
                        // 手动录入（v3.20）：动词已自动归类——沿用 onChange 全部语义（VA 重判/标记剥离/字段重置），
                        // 残留文本回填优先级：字段分段选项（"180"→"180°"）> 首个文本字段 > 仅动词本身。
                        // 显式整句录入 = 显式替换描述：用户刚用键盘写了这条内容，不适用"手改优先"保护。
                        setSdValues({});
                        setSdReach('');
                        const entry = motionStd.byType[verb];
                        const fields = entry?.format ? parseFormat(entry.format, verb) : [];
                        const nextVals: Record<string, string> = {};
                        for (const f of fields) {
                          if (!f.options) continue;
                          const hit = matchFieldOption(rest, f.options);
                          if (hit) { nextVals[f.name] = hit; break; }
                        }
                        if (Object.keys(nextVals).length === 0) {
                          const textField = fields.find((f) => !f.options);
                          if (textField && rest) nextVals[textField.name] = rest;
                        }
                        setSdValues(nextVals);
                        update(selectedElement.key, {
                          type: verb,
                          va_class: typeDefaultOf(verb),
                          va_reason: '',
                          desc: buildPreview(verb, fields, nextVals, ''),
                        });
                      }}
                    />
                  </div>
                  {sdFields.map((f) => {
                    const carryPending = carryHint?.key === selectedElement.key && f.name === objectFieldName(sdFields) && !!carryHint;
                    return (
                    <label className={`wb-field${f.kind === 'distance' ? ' wb-sd-dist' : ''}${carryPending ? ' wb-sd-carry' : ''}`} key={f.name}>
                      <span>
                        {f.name}{f.prep ? <i className="wb-sd-prep-tag">{f.prep}</i> : ''}
                        {f.kind === 'distance' && <em className="wb-sd-opt" title="选填：量得出才填（mm）——行程以部位档为准，距离只是档内细化依据">选填</em>}
                        {carryPending && <em className="wb-sd-confirm" title={carryHint.msg}>请确认</em>}
                      </span>
                      {f.options ? (
                        <div className="wb-seg sm">
                          {f.options.map((o) => (
                            <button key={o} type="button" className={sdValues[f.name] === o ? 'on' : ''}
                              onClick={() => { setSdValues((prev) => ({ ...prev, [f.name]: prev[f.name] === o ? '' : o })); if (carryPending) setCarryHint(null); }}>{o}</button>
                          ))}
                        </div>
                      ) : (
                        <input
                          value={sdValues[f.name] ?? ''}
                          onChange={(e) => { setSdValues((prev) => ({ ...prev, [f.name]: e.target.value })); if (carryPending) setCarryHint(null); }}
                          inputMode={f.kind === 'distance' ? 'decimal' : 'text'}
                          maxLength={20}
                        />
                      )}
                    </label>
                    );
                  })}
                </div>
                {sdFields.length === 0 && (
                  <div className="wb-sd-empty">该类型无标准描述格式，请直接在上方描述框手写</div>
                )}
                {/* 动作行程（部位档，v3.18）：视频场景不逐条量距离——部位即分档距离，
                    对应动作等级 手指1×/手腕2×/小臂3×（黄金作业域）/大臂4×/肩5×；
                    转身=角度、弯腰=程度、走动=步数（各走字段分段，不在此行） */}
                {needsBodyReach && (
                  <div className="wb-sd">
                    <label className="wb-field wb-sd-reach">
                      <span>动作行程<i className="wb-sd-prep-tag">部位</i></span>
                      <div className="wb-seg">
                        {BODY_REACH.map((r) => (
                          <button key={r} type="button" className={sdReach === r ? 'on' : ''} onClick={() => setSdReach(sdReach === r ? '' : r)}>{r}</button>
                        ))}
                      </div>
                    </label>
                  </div>
                )}
                {/* 预览已取消（v3.18 用户反馈）：组合结果直接自动写入上方标题（描述框），同内容不多处显示。
                    主操作按钮放到预览原来的位置——结构化描述区下方，不滚滚动条即可够到；快捷键 Ctrl+Enter 同效 */}
                <div className="wb-insp-foot sd">
                  <button className="btn primary sm" onClick={commitAndNext} title="记录本条并跳到下一个要素（快捷键 Ctrl+Enter；描述框内回车同效）">✓ 完成·下一个</button>
                  <button type="button" className="btn sm ghost" title="清空本区结构化字段与行程草稿（跨要素保留的草稿在此一键清掉）"
                    onClick={() => { setSdValues({}); setSdReach(''); setCarryHint(null); }}>清空</button>
                  <button className="btn sm danger" onClick={() => deleteElement(selectedElement.key)}>删除</button>
                </div>
              </div>

              <div className="wb-sec">
                <div className="wb-sec-t">手别</div>
                <div className="wb-seg">
                  {(['L', 'R', 'B'] as const).map((h) => (
                    <button key={h} type="button" className={selectedElement.hand === h ? 'on' : ''}
                      onClick={() => { update(selectedElement.key, { hand: h }); setHandMemo(h); }} title={h === handMemo ? `${HAND_LABEL[h]}（后续新要素沿用此手别）` : HAND_LABEL[h]}>
                      {HAND_LABEL[h]}
                    </button>
                  ))}
                </div>
                {/* 分界标准（动作标准 MS 的起止点融合进软件提示）：打点边界=起止点的现场判据 */}
                {sdEntry && sdEntry.sp && (
                  <div className="wb-boundary" title={`影响因素：${sdEntry.factors ?? '—'}`}>
                    <span className="wb-bd-t">分界</span>
                    <span className="wb-bd-item"><b>起</b>{sdEntry.sp}</span>
                    <span className="wb-bd-arrow">→</span>
                    <span className="wb-bd-item"><b>止</b>{sdEntry.ep}</span>
                    {sdEntry.factors && <span className="wb-bd-f">因素：{sdEntry.factors}</span>}
                  </div>
                )}
              </div>

              <div className="wb-sec">
                <div className="wb-sec-t">时间与工时</div>
                <div className="wb-row2">
                  <TimecodeField
                    label="起点"
                    value={selectedElement.start_ms}
                    onCommit={(ms) => {
                      const end = elEndMs(selectedElement);
                      if (ms >= end) { setFlash(`起点需小于止点（${fmtTime(end)}）`); setTimeout(() => setFlash(null), 2400); return; }
                      // 起点平移：时长不变，止点随起点右移
                      update(selectedElement.key, { start_ms: ms });
                    }}
                  />
                  <TimecodeField
                    label="止点"
                    value={elEndMs(selectedElement)}
                    onCommit={(ms) => {
                      if (ms <= selectedElement.start_ms) { setFlash(`止点需大于起点（${fmtTime(selectedElement.start_ms)}）`); setTimeout(() => setFlash(null), 2400); return; }
                      // 止点独立可变：起点不动，时长改为「新止点 - 起点」并量化到 10ms 网格
                      update(selectedElement.key, { dur_s: durToGrid((ms - selectedElement.start_ms) / 1000) });
                    }}
                  />
                  <label className="wb-field">
                    <span>时长 s</span>
                    <input type="number" step="0.01" value={selectedElement.dur_s}
                      onChange={(e) => update(selectedElement.key, { dur_s: Number(e.target.value) })}
                      onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0) update(selectedElement.key, { dur_s: durToGrid(v) }); }} />
                  </label>
                  <label className={`wb-field${selectedElement.rated ? '' : ' unrated'}`}>
                    <span>评比系数{selectedElement.rated === 'batch' && <em className="rt-tag batch">批量</em>}</span>
                    <input type="number" step="0.01" value={selectedElement.rating}
                      placeholder={selectedElement.rated ? undefined : '未评定'}
                      onChange={(e) => update(selectedElement.key, { rating: Number(e.target.value), rated: 'hand' })} />
                    {!selectedElement.rated && <em className="rt-tag unrated">未评定</em>}
                  </label>
                  <label className={`wb-field${selectedElement.rated ? '' : ' unrated'}`}>
                    <span>宽放率{selectedElement.rated === 'batch' && <em className="rt-tag batch">批量</em>}</span>
                    <input type="number" step="0.01" value={selectedElement.allowance}
                      placeholder={selectedElement.rated ? undefined : '未评定'}
                      onChange={(e) => update(selectedElement.key, { allowance: Number(e.target.value), rated: 'hand' })} />
                    {!selectedElement.rated && <em className="rt-tag unrated">未评定</em>}
                  </label>
                </div>
                <div className="wb-st">
                  <span title="时长 × 评比 × (1+宽放)">标准工时{!selectedElement.rated && <em className="rt-tag unrated" title="按默认 1.00/0.15 预估，提交前请批量或逐要素评定">默认值预估</em>}</span>
                  <b>{stdTime(selectedElement.dur_s, selectedElement.rating, selectedElement.allowance)}<i>s</i></b>
                </div>
              </div>

              <div className="wb-sec">
                <div className="wb-sec-t">标记<span className="wb-sec-t-sub">选类型即自动判定 VA 类别；手动改判须填理由（≥5字），提交自动备注 [VA改判] 标记</span></div>
                <div className="wb-seg va">
                  {(['VA', 'RNVA', 'NVA'] as const).map((v) => (
                    <button key={v} type="button" className={`${v.toLowerCase()}${selectedElement.va_class === v ? ' on' : ''}`}
                      onClick={() => {
                        const def = typeDefaultOf(selectedElement.type);
                        if (v !== def) {
                          // 手动改判：理由留模板预填（用户补完），提交时自动追加改判备注标记
                          update(selectedElement.key, {
                            va_class: v,
                            va_reason: selectedElement.va_reason || `类型${selectedElement.type}默认${def}，改判${v}因`,
                          });
                          setFlash(`#${selectedElement.seq} 改判 ${v}：请补完改判理由（提交时自动备注标记）`);
                          setTimeout(() => setFlash(null), 2800);
                        } else {
                          update(selectedElement.key, { va_class: v });
                        }
                      }}
                      title={`${VA_CLASS_LABEL[v].full} — ${VA_CLASS_LABEL[v].hint}`}>{v}</button>
                  ))}
                </div>
                {selectedElement.va_class !== typeDefaultOf(selectedElement.type) && (
                  <label className="wb-field" style={{ marginTop: 8 }}>
                    <span>改判理由</span>
                    <input value={selectedElement.va_reason} onChange={(e) => update(selectedElement.key, { va_reason: e.target.value })}
                      placeholder="如：治具已定向（≥5字，提交时写入标记）" />
                  </label>
                )}
              {/* 条件判定说明（动作标准 MS）：插/压/推/拉 等按作业对象区分增值性 */}
              {sdEntry?.vaNote && (
                <div className="wb-va-note" title="来自公司 VA/N-VA 判定表，可在「动作标准库」配置页维护">
                  <b>判定依据</b>{sdEntry.vaNote}
                </div>
              )}
              <div className="wb-mark-row">
                  <label className="wb-check">
                    <input type="checkbox" checked={selectedElement.outlier_flag === 1}
                      onChange={(e) => update(selectedElement.key, { outlier_flag: e.target.checked ? 1 : 0 })} />
                    <span>异常</span>
                  </label>
                  {selectedElement.outlier_flag === 1 && (
                    <input className="wb-mark-reason" value={selectedElement.outlier_reason}
                      onChange={(e) => update(selectedElement.key, { outlier_reason: e.target.value })}
                      placeholder="异常原因（如：设备停机-锁附枪卡死）" />
                  )}
                </div>
              </div>

              </>
            ) : (
            <div className="wb-insp-idle">
              <div className="wb-insp-idle-t">未选择要素</div>
              <div className="wb-insp-idle-d">在时间线上点选要素块进行编辑，或直接在监看区记录动作。</div>

              {/* 工位速览：不选要素时右侧不是空白，而是当前草稿的整体画面 */}
              <div className="wb-sec" style={{ marginTop: 14 }}>
                <div className="wb-sec-t">工位速览（草稿 {draft.length} 条）</div>
                <div className="stack-bar" title="VA / RNVA / NVA 工时结构（按标准工时）">
                  <span className="sb va" style={{ width: `${stats.vaPct}%` }} />
                  <span className="sb rnva" style={{ width: `${stats.ct > 0 ? (stats.rnva / stats.ct) * 100 : 0}%` }} />
                  <span className="sb nva" style={{ width: `${stats.ct > 0 ? (stats.nva / stats.ct) * 100 : 0}%` }} />
                </div>
                <div className="stack-legend">
                  <span><i className="va" />VA {stats.va}s</span>
                  <span><i className="rnva" />RNVA {stats.rnva}s</span>
                  <span><i className="nva" />NVA {stats.nva}s</span>
                </div>
                <table className="wb-idle-tbl">
                  <tbody>
                    <tr><td className="muted">预览 CT</td><td className="num">{stats.ct}s</td><td className="muted">VA 占比</td><td className="num">{stats.vaPct}%</td></tr>
                    <tr><td className="muted">节拍 TT</td><td className="num">{loaded.station.tt ?? '—'}s</td><td className="muted">异常要素</td><td className={`num${stats.outliers ? ' t-red' : ''}`}>{stats.outliers}</td></tr>
                    <tr><td className="muted">左手 L</td><td className="num">{handCount.L}</td><td className="muted">右手 R</td><td className="num">{handCount.R}</td></tr>
                    <tr><td className="muted">双手 B</td><td className="num">{handCount.B}</td><td className="muted">去分析</td><td className="num"><a href={`#/analysis/${loaded.station.station_id}`}>结果 →</a></td></tr>
                  </tbody>
                </table>
              </div>

              <div className="wb-sec" style={{ marginTop: 16 }}>
                <div className="wb-sec-t">版本<button type="button" className="wb-sec-t-sub" onClick={() => setVerExpanded((v) => !v)}>
                  {verExpanded ? '收起' : effVersions.length > VER_PAGE ? `展开全部 ${effVersions.length} 个` : ''}
                </button></div>
                {(verExpanded ? effVersions : effVersions.slice(-VER_PAGE)).map((v) => (
                  <div key={v.version} className={`wb-ver${v.is_current ? ' cur' : ''}`}>
                    <span className="mono">v{v.version}</span>
                    <span className="muted">{v.element_count} 要素 · CT {v.ct}s</span>
                    <span className={`tag ${v.is_current ? 't-blue' : v.is_sealed ? 't-gray' : 't-teal'}`}>
                      {v.is_current ? '当前' : v.is_sealed ? '封存' : '草稿'}
                    </span>
                  </div>
                ))}
                {!verExpanded && effVersions.length > VER_PAGE && (
                  <div className="wb-ver more" onClick={() => setVerExpanded(true)} title="点击展开全部有效版本">
                    更早的 {effVersions.length - VER_PAGE} 个有效版本…
                  </div>
                )}
                {emptyVerCount > 0 && (
                  <div className="wb-ver empty" title="开始复测但未提交要素的空壳版本（服务端已有护栏，不会再新增；不参与对比与复用）">
                    另有 {emptyVerCount} 个空版本（无要素，不计入）
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* 时间线条（通栏 · 默认展开）：与属性检查器同屏并存，填属性/拖边界互不遮挡。
          时间线/清单只是条内视图切换——不再有"关面板→切模式→再切回"的往返操作 */}
      <section className={`wb-tlstrip${tlOpen ? '' : ' closed'}`}>
          <div className="wb-tlstrip-head">
            <div className="wb-tabs">
              <button type="button" className={panelTab === 'timeline' ? 'on' : ''} onClick={() => { setPanelTab('timeline'); setTlOpen(true); }}>时间线</button>
              <button type="button" className={panelTab === 'list' ? 'on' : ''} onClick={() => { setPanelTab('list'); setTlOpen(true); }}>
                清单<span className="cnt">{draft.length}</span>
              </button>
            </div>
            {selectedElement && (
              <div className="wb-panel-sel mono" title="当前选中要素；拖拽边界时此处实时显示起止时刻（ms）">
                #{selectedElement.seq} {selectedElement.desc} · {selectedElement.start_ms}→{selectedElement.start_ms + Math.round(selectedElement.dur_s * 1000)}ms
                {/* v3.22：片段播放态提示（默认单次；循环开时给出显式取消入口） */}
                {segLoop && (
                  <button type="button" className="wb-seg-cancel" onClick={() => setSelected(null)}
                    title="取消片段循环，恢复全片播放（Esc / 再点一次该块 同效）">↻ 循环中 · 取消</button>
                )}
              </div>
            )}
            <div className="wb-legend">
              <span><i className="va" />VA {stats.va}s</span>
              <span><i className="rnva" />RNVA {stats.rnva}s</span>
              <span><i className="nva" />NVA {stats.nva}s</span>
              {(unratedCount > 0 || batchCount > 0) && (
                <span className="wb-legend-rt" title="ST 取值优先级：手改 > 批量 > 默认 1.00/0.15（未评定要素按默认值预估）">
                  <i className="rt-hand" />手改 {handRatedCount}
                  <i className="rt-batch" />批量 {batchCount}
                  <i className="rt-def" />未评 {unratedCount}
                </span>
              )}
            </div>
            <button className="wb-tlstrip-toggle" onClick={() => setTlOpen((v) => !v)}
              title={tlOpen ? '收起时间线：把纵向空间让给视频' : '展开时间线'}>
              {tlOpen ? '▾ 收起' : '▴ 展开时间线'}
            </button>
          </div>
          {tlOpen && (
          <div className={`wb-tlstrip-body${panelTab === 'list' ? ' is-list' : ''}`}>
            {panelTab === 'timeline' ? (
          <div className="timeline-wrap wb-tl" ref={tlWrapRef}>
            <div className="timeline" style={{ width: widthPx }}>
              <div className="tl-ruler">
                {rulerTicks.map((ms) => (
                  <span key={ms} style={{ left: 44 + (ms / 1000) * PX_PER_SEC }}>{(ms / 1000).toFixed(0)}s</span>
                ))}
              </div>
              {(['L', 'R', 'B'] as const).map((hand) => (
                <div className="tl-row" key={hand}>
                  <div className="tl-label">{HAND_LABEL[hand]}</div>
                  <div
                    className="tl-lane"
                    ref={(node) => { lanesRef.current[hand] = node; }}
                    onClick={(event) => onLaneClick(hand, event)}
                    onDoubleClick={(event) => onLaneDoubleClick(hand, event)}
                  >
                    {draft.filter((d) => d.hand === hand).map((element) => (
                      <div
                        key={element.key}
                        className={`block ${element.va_class === 'VA' ? 'va' : element.va_class === 'RNVA' ? 'rnva' : 'nva'} ${selected === element.key ? 'selected' : ''} ${element.outlier_flag === 1 ? 'outlier' : ''}`}
                        style={{ left: (element.start_ms / 1000) * PX_PER_SEC, width: Math.max(10, element.dur_s * PX_PER_SEC - 2) }}
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          // v3.48 时间线点击联动（用户需求）：单击要素块 = 选中/取消选中，
                          // **且视频已加载时播放点自动跳到该片段计时起点**（无论当前视频是否为
                          // 该片段真实视频——重复查看作业内容用；无视频时仅移动时间线播放头）。
                          // 兼容说明：v3.22 曾因「点选即拽回块起点」与 O 设止点流程冲突而移除
                          // 该行为；本次按用户明确需求恢复，双击（定位到点击位置）与边界拖拽
                          // 语义不变，需要精确定位时仍用双击。
                          if (selected === element.key) { setSelected(null); return; }
                          setSelected(element.key);
                          seek(element.start_ms);
                        }}
                        onClick={(event) => event.stopPropagation()}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          // v3.54 使时间段连续（用户需求）：右键片段 → 弹出确认 → 起点对齐相邻上一片段止点
                          setSelected(element.key);
                          setContiguousTarget({ el: element, x: event.clientX, y: event.clientY });
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          // 双击块 = 定位播放头到双击位置（原单击行为）；仍保留分割？否——
                          // 分割移到 Shift+双击 与控制栏按钮/快捷键 S，双击定位是主路径
                          const lane = lanesRef.current[hand];
                          if (lane) {
                            const rect = lane.getBoundingClientRect();
                            seek(Math.max(0, Math.round((event.clientX - rect.left) / PX_PER_SEC * 1000)));
                          }
                        }}
                        title={`#${element.seq} ${element.desc} ${element.dur_s}s（单击选中并跳到片段起点；双击定位播放头到点击处；再点一次取消选中；右键使时间段连续）`}
                      >
                        <span className="grip l" onPointerDown={(event) => startDrag(event, element, 'l')} />
                        <span className="blk-seq">#{element.seq}</span> {element.desc}
                        <span className="grip r" onPointerDown={(event) => startDrag(event, element, 'r')} />
                      </div>
                    ))}
                    <div className="playhead" style={{ left: (playhead / 1000) * PX_PER_SEC }} />
                    {dragInfo?.snapMs != null && (
                      <div className="snap-guide" style={{ left: (dragInfo.snapMs / 1000) * PX_PER_SEC }}>
                        <em>{dragInfo.snapMs}ms</em>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="wb-list">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th><th>手别</th><th>类型</th><th>描述</th>
                  <th className="num">起点</th><th className="num">止点</th><th className="num">时长 s</th><th className="num">ST s</th><th>VA</th><th>异常</th>
                  {canWrite && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {[...draft].sort((a, b) => a.start_ms - b.start_ms).map((element) => (
                  <tr key={element.key} className={selected === element.key ? 'on' : ''} onClick={() => setSelected(element.key)}>
                    <td className="num">{element.seq}</td>
                    <td>{HAND_LABEL[element.hand]}</td>
                    <td>{element.type}</td>
                    <td>
                      {isBareVerbDesc(element.type, element.desc) ? (
                        <span className="wb-desc-missing" title="描述只有动素类型、缺少作业内容（对象/位置等）——点击编辑补全，否则提交会被拦截">
                          {element.desc || '（空）'}<span className="wb-desc-warn"><IconWarnTri /> 缺对象</span>
                        </span>
                      ) : (
                        element.desc
                      )}
                    </td>
                    <td className="num mono" title={`起点 ${element.start_ms} ms`}>{fmtTimecode(element.start_ms)}</td>
                    <td className="num mono" title={`止点 ${elEndMs(element)} ms`}>{fmtTimecode(elEndMs(element))}</td>
                    <td className="num">{element.dur_s}</td>
                    <td className="num">{stdTime(element.dur_s, element.rating, element.allowance)}</td>
                    <td><span className={`tag ${element.va_class === 'VA' ? 't-teal' : element.va_class === 'RNVA' ? 't-amber' : 't-red'}`}>{element.va_class}</span></td>
                    <td className="muted">{element.outlier_flag === 1 ? element.outlier_reason : '—'}</td>
                    {canWrite && (
                      <td className="wb-row-acts">
                        <button className="btn sm ghost" title="编辑该要素" onClick={(e) => {
                          e.stopPropagation();
                          setSelected(element.key);
                          requestAnimationFrame(() => { descRef.current?.focus(); descRef.current?.select(); });
                        }}>编辑</button>
                        <button className="btn sm ghost danger" title="删除该要素（30 秒内可撤销）" onClick={(e) => { e.stopPropagation(); deleteElement(element.key); }}>删除</button>
                      </td>
                    )}
                  </tr>
                ))}
                {draft.length === 0 && (
                  <tr><td colSpan={10} className="empty">还没有要素：在监看区记录动作，或从工位清单导入 CSV。</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
          </div>
          )}
      </section>

      {/* 交付条：参数与提交动作集中于此，常驻底部 */}
      <div className="wb-actionbar no-print">
        <div className="wb-deliver">
          {canWrite && <span className="wb-ab-label">交付参数</span>}
          {canWrite && (
            <>
              <label className="wb-ab-field">
                <span>循环</span>
                <input type="number" min={0} value={cycles} onChange={(e) => setCycles(Number(e.target.value))} />
              </label>
              <label className="wb-ab-field">
                <span>CV</span>
                <input type="number" step="0.01" value={cv} onChange={(e) => setCv(Number(e.target.value))} />
              </label>
              {/* 新片段默认时长（v3.26 用户反馈）：连续生成时新片段以此时长起播，按需调整 */}
              <label className="wb-ab-field" title="新增片段的默认时长（秒）：完成·下一个 / ＋新增 生成的新片段按此时长起步，之后可用拖拽或 I/O 精修">
                <span>新片段</span>
                <input type="number" step="0.1" min="0.1" max="60" value={newDurS} onChange={(e) => setNewDurS(Math.min(60, Math.max(0.1, Number(e.target.value) || 1)))} />
                <i className="wb-ab-unit">s</i>
              </label>
              {/* 循环/CV 实时引导（会审 P0-2）：固定高度单行条，优先级 循环>CV>未评定——有提示无提示交付条等高，监看区高度不抖动 */}
              <div className="wb-hint-strip" title={abHint?.title ?? undefined}>
                {abHint && <em className={`wb-hint ${abHint.level}`}>{abHint.text}</em>}
              </div>
              <span className={`tag ${v3ok ? 't-teal' : (cycles >= 15 ? 't-amber' : 't-red')}`} title="V3 门槛：循环≥15；CV>0.15 时须≥25">
                V3 {v3ok ? '达标' : cycles < 15 ? '循环不足' : '须加测'}
              </span>
            </>
          )}
          {!canWrite && <span className="muted" style={{ fontSize: 12 }}>只读视图 · 可查看分解结果，无编辑权限</span>}
        </div>
        <div className="wb-ab-actions">
          <button className="btn sm ghost" onClick={() => void api.exportElementsCsv(stationId)}>导出 CSV</button>
          {canWrite && (
            <>
              <button className="btn sm" disabled={busy || draft.length === 0} onClick={runValidate}>校验</button>
              <button className="btn sm ghost danger" disabled={busy || draft.length === 0} onClick={clearAll}
                title={`一键清空当前 ${draft.length} 条未提交草稿，重新开始（二次确认；已提交的版本不受影响）`}>
                清空{draft.length > 0 ? `（${draft.length}）` : ''}
              </button>
              <button className="btn primary sm" disabled={busy || draft.length === 0} onClick={submit}>
                {busy ? '提交中…' : '提交分解'}
              </button>
            </>
          )}
          {canRetest && (
            <details className="wb-more">
              <summary className="btn sm ghost">版本</summary>
              <div className="wb-more-menu">
                <button className="btn sm" onClick={startRetest}
                  title={loaded.elements.length === 0 ? '当前版本还没有要素，无需复测' : '把当前版本封存为只读，新建下一版本空白分解'}>开始复测</button>
                <button className="btn sm danger" onClick={cancelRetest} disabled={loaded.station.version <= 1}>作废复测</button>
                {effVersions.length >= 2 && (
                  <a className="btn sm" href={`#/diff/${loaded.station.station_id}/${effVersions[effVersions.length - 2].version}/${loaded.station.version}`}
                    title={`与上一个有效版本（v${effVersions[effVersions.length - 2].version}）逐条比对：改了什么、CT 影响多少`}>
                    对比上一有效版本 v{effVersions[effVersions.length - 2].version}→v{loaded.station.version}
                  </a>
                )}
                <div className="muted">已封存：{sealed.map((v) => v.version).join('、') || '无'}</div>
                {sealed.map((v) => {
                  // 对比目标 = 下一个有效版本（跳过中间的空壳版本，避免"和空版本对比"）
                  const next = effVersions.find((e) => e.version > v.version);
                  const target = next?.version ?? v.version + 1;
                  return (
                    <a key={v.version} className="wb-vs-row" href={`#/diff/${loaded.station.station_id}/${v.version}/${target}`}
                      title={`对比 v${v.version} 与后继有效版本 v${target} 的要素结构差异`}>
                      <span className="mono">v{v.version}</span>
                      <span className="muted">{v.element_count} 要素 / CT {v.ct}s</span>
                      <span className="rz-go">对比 →</span>
                    </a>
                  );
                })}
              </div>
            </details>
          )}
        </div>
      </div>

      <input ref={fileRef} type="file" accept={VIDEO_ACCEPT} style={{ display: 'none' }} onChange={(e) => { pickVideo(e.target.files?.[0]); e.target.value = ''; }} />

      {/* 拖拽边界时的光标旁时间提示（position:fixed，不占布局；含吸附状态） */}
      {dragInfo && (
        <div className="wb-drag-tip" style={{ left: dragInfo.x + 14, top: dragInfo.y + 14 }}>
          {dragInfo.text}{dragInfo.snapMs != null && <b> · 已吸附</b>}
        </div>
      )}

      {/* 复用要素结构（跨循环 / 跨工位）：IE 现场同一动作结构反复出现，不必每次从零录 */}
      {showReuse && (
        <div className="modal-mask" onClick={() => setShowReuse(false)}>
          <div className="modal rz" onClick={(e) => e.stopPropagation()}>
            <h3>复用要素结构</h3>
            <p className="muted">把已有分解结构套到当前工位：适合「同一工位的第 2 个循环」「同线相似工位」「复测沿用上一版」。</p>
            <div className="rz-mode">
              <label><input type="radio" checked={reuseMode === 'append'} onChange={() => setReuseMode('append')} />
                追加到播放头之后（保留现有 {draft.length} 条）
              </label>
              <label><input type="radio" checked={reuseMode === 'replace'} onChange={() => setReuseMode('replace')} />
                替换当前全部要素
              </label>
            </div>
            <div className="rz-mode">
              <label title="跨工位沿用原评比/宽放会掩盖真实差异；默认不复制，提交前按本工位重新评定">
                <input type="checkbox" checked={reuseCopyRating} onChange={(e) => setReuseCopyRating(e.target.checked)} />
                同时复制评比与宽放（默认关闭——复用后请按本工位重新评定）
              </label>
            </div>
            <div className="rz-list">
              <div className="rz-group-t">本工位历史版本（上一循环 / 复测结构）</div>
              {prevVersions.length === 0 && <div className="muted" style={{ padding: '4px 2px' }}>暂无可复用历史版本</div>}
              {prevVersions.map((v) => (
                <button key={v.version} className="rz-row" disabled={reuseBusy}
                  onClick={() => void applyReuse({ kind: 'prev', version: v.version, count: v.element_count })}>
                  <span className="rz-name">v{v.version} <span className="tag t-gray">{v.is_sealed ? '封存' : '历史'}</span></span>
                  <span className="muted">{v.element_count} 要素 · CT {v.ct}s</span>
                  <span className="rz-go">复用 →</span>
                </button>
              ))}
              <div className="rz-group-t">同线其他工位（{siblings.length}）</div>
              {siblings.length === 0 && <div className="muted" style={{ padding: '4px 2px' }}>同线暂无其他有分解数据的工位</div>}
              {siblings.map((sb) => (
                <button key={sb.station_id} className="rz-row" disabled={reuseBusy}
                  onClick={() => void applyReuse({ kind: 'station', stationId: sb.station_id, name: sb.name })}>
                  <span className="rz-name">{sb.name} <span className="mono muted">{sb.station_id}</span></span>
                  <span className="muted">{sb.element_count} 要素</span>
                  <span className="rz-go">复用 →</span>
                </button>
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setShowReuse(false)}>取消</button>
            </div>
          </div>
        </div>
      )}

      {/* 使时间段连续（v3.55，用户需求）：右键片段弹出小上下文菜单，把其起点对齐到相邻上一片段止点（止点不动） */}
      {contiguousTarget && (() => {
        const target = contiguousTarget.el;
        const sorted = [...draft].sort((a, b) => a.start_ms - b.start_ms);
        const idx = sorted.findIndex((d) => d.key === target.key);
        const prev = idx > 0 ? sorted[idx - 1] : null;
        const prevEnd = prev ? elEndMs(prev) : null;
        return (
          <>
            {/* 透明遮罩：点击任意处关闭（不拦截滚动/其它交互，仅关闭菜单） */}
            <div className="ctx-mask" onClick={() => setContiguousTarget(null)} />
            <div
              className="ctx-menu"
              style={{
                left: Math.min(contiguousTarget.x, window.innerWidth - 330),
                top: Math.min(contiguousTarget.y, window.innerHeight - 190),
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="ctx-title">使时间段连续</div>
              <div className="ctx-desc">把 <b>#{target.seq}</b> 起点对齐到上一片段止点（止点不变、时长缩短）</div>
              {prev ? (
                <div className="ctx-preview">
                  <div>上一片段 <b>#{prev.seq}</b> 止点：<span className="mono">{fmtTimecode(prevEnd!)}</span></div>
                  <div>本片段起点：<span className="mono">{fmtTimecode(target.start_ms)}</span> → <b className="mono">{fmtTimecode(prevEnd!)}</b></div>
                </div>
              ) : (
                <div className="ctx-desc muted">已是第一个片段，没有可对齐的上一个片段。</div>
              )}
              {prev && (
                <button className="btn primary ctx-btn" onClick={makeContiguous}>对齐到上一片段止点</button>
              )}
            </div>
          </>
        );
      })()}

      {/* 描述联想：同线历史短语 + 公司标准骨架（DB 发布版即时生效；仅提示，不代填真实现场值） */}
      <datalist id="wb-desc-hints">
        {allDescHints.map((h) => <option key={h} value={h} />)}
      </datalist>

      {/* 快捷键帮助：界面唯一展示快捷键的位置 */}
      {showHelp && (
        <div className="modal-mask" onClick={() => setShowHelp(false)}>
          <div className="modal shortcut-modal" onClick={(e) => e.stopPropagation()}>
            <h3>操作流程与快捷键</h3>

            {/* 标准作业流：新用户照此走一遍即可完成一个工位的分解（页面上不显示提示，全部收在此处） */}
            <ol className="sc-flow">
              <li><b>载入视频</b><span>监看区右上「载入视频」，选该工位的现场录像（手机横拍也可）</span></li>
              <li><b>找循环起点</b><span>Space 播放，看到第一循环开始处停下，点时间线或用 ←→ 逐帧对齐</span></li>
              <li><b>粗切动作边界</b><span>继续播放，每到动作切换点按 <kbd>S</kbd> 分割——播放不会中断，边看边打点最快（粒度口诀：<b>手一停，就打点</b>，正反示例见下方）</span></li>
              <li><b>逐帧精修</b><span>选中有疑问的要素，<kbd>←</kbd><kbd>→</kbd> 走一帧（步长随视频帧率自动适配，时间码精确到毫秒）；差几毫秒用 <kbd>Alt</kbd>+<kbd>←</kbd><kbd>→</kbd>；边界拧不准用 <kbd>,</kbd> <kbd>.</kbd> <kbd>[</kbd> <kbd>]</kbd> 按帧微调起/止点（<kbd>Shift</kbd> = 10 帧）；判断吃力的画面按 <kbd>F</kbd> 全屏放大</span></li>
              <li><b>标注内容</b><span>点块 → 右侧检查器选类型/手别、写描述，<kbd>Enter</kbd> 即记录并跳到下一条。选类型不必翻列表：聚焦「动作要素」框直接输入——<b>转身 / 转 / zs</b> 都能直达，回车选定；整句录入（如「转身180度」）自动识别动词归类、残留回填字段</span></li>
              <li><b>判定与异常</b><span>VA/RNVA/NVA 随类型自动带出；改判要写理由；非正常周期勾「异常」（不进 ST 与山积图）</span></li>
              <li><b>交付</b><span>展开时间线核对 → 填循环数 / CV → 校验 → 提交分解，生成新版本</span></li>
            </ol>
            <div className="sc-tip">
              重复动作不必重录：<kbd>D</kbd> 同上新增沿用上一条属性；整段结构可用「复用要素」从上一版本或同线工位套用。
              任何操作记不得快捷键：按 <kbd>Ctrl</kbd>+<kbd>K</kbd>（或顶栏工具箱按钮）唤起<b>快捷工具箱</b>——输入即过滤、回车执行，面板本身即活的快捷键表。
            </div>

            {/* 打点粒度示范（会审 P1：新手首次打点必然犹豫，帮助内给正反示例） */}
            <div className="sc-gran">
              <div className="sc-gran-motto">粒度口诀：<b>手一停，就打点</b>——眼睛盯着手，不盯着表</div>
              <div className="sc-gran-ask">
                拿不准先问自己三句：<b>① 手停了没有？② 东西交了没有？③ 性质变了没有？</b>
                三个里有一个答"是"，这里就该打一个点。判断依据是手上的动作，不是心里默秒。
              </div>
              <div className="sc-gran-cards">
                <div className="sc-gran-card">
                  <h5>移物类（取/运/放必须分开）</h5>
                  <div className="sc-gran-line ok"><span className="g-tag">正确</span>「握取螺丝」1s + 「移物到工件」1s + 「放手放置」0.8s → <b>3 个点</b></div>
                  <div className="sc-gran-line bad"><span className="g-tag">过粗</span>「取螺丝并装上」3s → 1 个点（ST 看不出浪费在哪）</div>
                  <div className="sc-gran-line bad"><span className="g-tag">过细</span>「伸手」0.3s + 「抓」0.2s + 「转身」0.3s → 6 个点（录到哭，改善也用不上）</div>
                </div>
                <div className="sc-gran-card">
                  <h5>寻找/选择类（犹豫/挑选/换手全是独立要素）</h5>
                  <div className="sc-gran-line ok"><span className="g-tag">正确</span>「寻找工具」0.4s + 「拿起对准」0.5s → <b>2 个点</b>（寻找单列才看得见）</div>
                  <div className="sc-gran-line bad"><span className="g-tag">过粗</span>「准备工具」0.9s → 1 个点（NVA 被藏进"准备"两个字里）</div>
                  <div className="sc-gran-line bad"><span className="g-tag">过细</span>「视线移动」0.1s + 「头转向」0.1s → 每 0.1s 一个点（小于帧步进，边界也稳不了）</div>
                </div>
                <div className="sc-gran-card">
                  <h5>持住 + 检查类（连续动作中间不停手）</h5>
                  <div className="sc-gran-line ok"><span className="g-tag">正确</span>「左手持住零件」2s + 「右手检查尺寸」0.6s + 「放手放回」0.5s → <b>3 个点</b></div>
                  <div className="sc-gran-line bad"><span className="g-tag">过粗</span>「一边扶着一边检」2.6s → 1 个点（持住全被吞掉）</div>
                  <div className="sc-gran-line bad"><span className="g-tag">过细</span>「持住」0.5s + 「还持着」0.5s + 「继续持」1s → 手根本没停，不该打点</div>
                </div>
              </div>
              <div className="sc-gran-mix">
                <b>两个最易错的二选一：</b>
                ① <b>装配 vs 定位</b>——零件"最终装上/拧紧"是装配；"先对准/半搭/预留"是定位；试装不拧紧算定位。
                ② <b>检查 vs 延迟</b>——自己动手量/看是检查；机器或别人干活你闲着是延迟（可避免/不可避免）。
                打点时犹豫的那几秒，本身可能就是寻找或延迟——犹豫处往往就是改善点。
                <br />
                <b>描述标准化（行业最佳实践）：</b>按「动素＋操作对象＋介词＋位置要素（＋动作行程）」写，如<b>握取 前横梁 于 物料箱（手腕）</b>——
                动词就是结构化描述区首位选的动作要素，填对象/位置/行程可一键生成；同构描述才能被检索、汇总、建立数据模型。
              </div>
              <div className="sc-gran-bar" aria-label="典型工位节奏示意">
                <span className="g-bar" style={{ width: '17%', background: 'var(--blue)' }}>移物 1s</span>
                <span className="g-bar" style={{ width: '7%', background: 'var(--red)' }}>寻找 0.4s</span>
                <span className="g-bar" style={{ width: '13%', background: 'var(--amber)' }}>定位 0.8s</span>
                <span className="g-bar" style={{ width: '50%', background: 'var(--teal)' }}>装配 3s</span>
                <span className="g-bar" style={{ width: '13%', background: 'var(--ink3)' }}>持住 2s</span>
              </div>
              <div className="sc-gran-count">
                <b>数量参照：</b>一个 60 秒节拍的工位，粗切完一般是 <b>10~12 个要素</b>（≈1.2s/要素）。不到 5 个大概率打粗了；超过 25 个大概率打细了——两种情况都回上方示例对照。
              </div>
              <div className="sc-gran-check">
                <b>提交前三步自检：</b>① 每个要素都能不看视频复述出"手在干什么"；② 时长都 ≥0.15s（低于此值先查是不是该和上一个要素合并）；③ 展开时间线扫一眼，有没有两个块叠在一起或中间裂个大空档。
                <em>反例警告：打得太细不会让分析更准，只会把 CT 虚高、把改善淹没在噪音里。</em>
              </div>
            </div>

            {/* 动作标准类型表（v3.16 公司动作分解标准：选类型的依据，类型决定默认 VA 类别） */}
            <div className="sc-therblig">
              <div className="sc-therblig-t">动作标准（《动作分解标准》+《VA/N-VA 判定表》）——打点选类型的依据（类型自动决定默认 VA 类别）</div>
              <div className="sc-therblig-cols">
                {(['VA', 'RNVA', 'NVA'] as const).map((va) => (
                  <div key={va} className={`sc-th-col ${va.toLowerCase()}`}>
                    <h5>{VA_CLASS_LABEL[va].short}<em>→ {VA_CLASS_LABEL[va].full.split('（')[0]}</em></h5>
                    <p>{VA_CLASS_LABEL[va].hint}</p>
                    <ul>{motionStd.entries.filter((e) => e.va === va).map((e) => <li key={e.type} title={`${e.desc}\n分界：起 ${e.sp} → 止 ${e.ep}`}>{e.type}</li>)}</ul>
                  </div>
                ))}
              </div>
              <div className="sc-therblig-note">
                检查器中动素类型居结构化描述区首位（=描述句首动词，如「拿取 后横梁 于 料箱 150（手腕）」），选后按标准格式生成字段、自动写入描述；行程用部位档（手指/手腕/小臂/大臂/肩）标识——视频场景不逐条量距离，距离字段选填；转身记角度、弯腰记程度、走动记步数。
                插/压/推/拉 默认按工夹具记 RNVA，对象为装入产品的物料时请改判 VA（自动预填理由模板）。另有经典动素（旧数据兼容）与「其他」兜底。改判 VA 类别必须写理由——自动默认值不允许静默覆盖。各类型完整定义、描述格式、分界标准与行程标识方法详见「动作标准库」配置页与《动作标准与填写说明》文档。
              </div>
            </div>

            <div className="sc-grid">
              <div className="sc-group">
                <h4>播放</h4>
                <div className="sc-row"><span>播放 / 暂停<br /><i className="sc-sub">选中要素时 = 片段播放（默认单次：起点前 0.4s → 止点播完即停；控制栏「↻ 循环」开关可改循环）</i></span><kbd>Space</kbd></div>
                <div className="sc-row"><span>穿梭三键（剪辑软件 JKL 惯例）<br /><i className="sc-sub">按住 L = 连续正放（播到片尾，不受片段止点拦截）、松开即停；K 暂停（帧对齐）；按住 J = 按帧回退倒放（速率随倍率，轻点退数帧，Shift+J = 一步 10 帧）</i></span><span><kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd></span></div>
                <div className="sc-row"><span>片段循环开关（与倍率同行）<br /><i className="sc-sub">默认关 = 单次播完即停；开 = 到止点回起点反复播，核对动作边界用</i></span><span className="muted mono">↻ 循环</span></div>
                <div className="sc-row"><span>取消选中（恢复全片）<br /><i className="sc-sub">Esc / 再点一次选中的块 / 视频上的片段浮标</i></span><kbd>Esc</kbd></div>
                <div className="sc-row"><span>减速 / 加速（0.25×–1×）</span><span><kbd>−</kbd> <kbd>+</kbd></span></div>
              </div>
              <div className="sc-group">
                <h4>帧级导航</h4>
                <div className="sc-row"><span>后退 / 前进一帧<br /><i className="sc-sub">按视频实测帧率：30fps≈33ms，60fps≈17ms</i></span><span><kbd>←</kbd> <kbd>→</kbd></span></div>
                <div className="sc-row"><span>微调 1/4 帧<br /><i className="sc-sub">浏览器 seek 精度内最细档，边界差几毫秒时用</i></span><span><kbd>Alt</kbd> + <kbd>←</kbd> <kbd>→</kbd></span></div>
                <div className="sc-row"><span>后退 / 前进 1 秒</span><span><kbd>⇧←</kbd> <kbd>⇧→</kbd></span></div>
                <div className="sc-row"><span>跳上一 / 下一要素边界</span><span><kbd>↑</kbd> <kbd>↓</kbd></span></div>
                <div className="sc-row"><span>时间线起点 / 末端</span><span><kbd>Home</kbd> <kbd>End</kbd></span></div>
              </div>
              <div className="sc-group">
                <h4>起止点精修（剪辑软件惯例）</h4>
                <div className="sc-row"><span>设起点 = 选中要素起点移到播放头<br /><i className="sc-sub">误标修正回路：←→ 逐帧对准 → 按 I 即改，不拖块、不敲数字；起止非法自动顺延一帧</i></span><kbd>I</kbd></div>
                <div className="sc-row"><span>设止点 = 选中要素止点移到播放头</span><kbd>O</kbd></div>
                <div className="sc-row"><span>起点 −/+ 1 帧（Shift = 10 帧）<br /><i className="sc-sub">边看边拧，焦点不离开画面；与 I/O 互补</i></span><span><kbd>,</kbd> <kbd>.</kbd></span></div>
                <div className="sc-row"><span>止点 −/+ 1 帧（Shift = 10 帧）</span><span><kbd>[</kbd> <kbd>]</kbd></span></div>
                <div className="sc-row"><span>完成·下一个 = 记录本条并跳到下一条<br /><i className="sc-sub">结构化描述区下方「✓ 完成·下一个」按钮同效；描述框内回车亦可</i></span><span><kbd>Ctrl</kbd>+<kbd>↵</kbd></span></div>
              </div>
              <div className="sc-group">
                <h4>快速记录</h4>
                <div className="sc-row"><span>快捷工具箱（全部操作一处唤起，输入即过滤）</span><span><kbd>Ctrl</kbd>+<kbd>K</kbd></span></div>
                <div className="sc-row"><span>动作要素检索（聚焦类型框直接输入：转身/转/zs 直达；整句录入自动归类）</span><span className="muted mono">type</span></div>
                <div className="sc-row"><span>播放头分割（自动定位要素）</span><kbd>S</kbd></div>
                <div className="sc-row"><span>新增要素<br /><i className="sc-sub">紧接前一要素止点生成连续片段，编号=最大编号+1；时长按交付条「新片段」设定</i></span><kbd>N</kbd></div>
                <div className="sc-row"><span>同上新增<br /><i className="sc-sub">复制末要素类型/描述/工时参数，片段仍与止点拼接连续</i></span><kbd>D</kbd></div>
                <div className="sc-row"><span>对象继承预填<br /><i className="sc-sub">组合动作（拿取→放置、插→按…）自动带入上一要素的对象，位置等参数重填；不确定的组合（检查后返工/设备段）带「请确认」标注，改写即确认；新循环自动从空白开始</i></span><span className="muted">自动</span></div>
                <div className="sc-row"><span>选中要素手别 左/右/双<br /><i className="sc-sub">选定后新要素沿用此手别（默认双手），免逐条点选</i></span><span><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></span></div>
                <div className="sc-row"><span>删除选中要素</span><kbd>Del</kbd></div>
              </div>
              <div className="sc-group">
                <h4>鼠标</h4>
                <div className="sc-row"><span>单击时间线要素块 = 选中并跳到片段起点（v3.48 联动，已加载视频时重复查看作业内容）<br /><i className="sc-sub">双击时间线（空白或要素块）= 定位播放头到点击位置——需要帧级精确定位时用双击</i></span><span className="muted mono">click / dblclick</span></div>
                <div className="sc-row"><span>单击要素块 = 选中（再点一次取消选中）</span><span className="muted mono">click</span></div>
                <div className="sc-row"><span>拖拽块左右边缘 = 粗调边界（12px 内磁吸相邻要素边界/播放头，参考线蓝亮即贴合）<br /><i className="sc-sub">拖拽只适合粗调：40px/s 刻度下 1 帧≈1.3px，鼠标不可能准——精修用 <kbd>,</kbd><kbd>.</kbd><kbd>[</kbd><kbd>]</kbd></i></span><span className="muted mono">drag</span></div>
                <div className="sc-row"><span>播放头分割（自动定位覆盖要素）</span><kbd>S</kbd></div>
                <div className="sc-row"><span>全屏工作台（再按一次退出）</span><kbd>F</kbd></div>
                <div className="sc-row"><span>取消选中 / 关闭本窗</span><kbd>Esc</kbd></div>
              </div>
            </div>
            <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
              输入框聚焦时单键快捷键不接管（Ctrl+Enter 与 Esc 例外）；无视频时全部导航与记录动作同样可用（基于时间线）。
              分割不打断播放——边看边打点是视频分解最省时的做法。
            </p>
          </div>
        </div>
      )}

      {/* 快捷工具箱（v3.20）：Ctrl+K / 顶栏工具箱按钮唤起 */}
      <Toolbox open={toolboxOpen} onClose={() => setToolboxOpen(false)} actions={toolActions} />
    </div>
  );
}
