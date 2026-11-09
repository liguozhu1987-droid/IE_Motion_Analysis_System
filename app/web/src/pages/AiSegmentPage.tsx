/**
 * AI 自动分解（v3.34）—— 与「分解工作台」**并列**的独立页面。
 *
 * 定位：视频 → 动作候选分段 → 人工确认 → 写入本工位要素（作为初稿）
 * 边界：
 *  - 本页面不改动分解工作台任何交互；写入后由工作台承担精修与提交
 *  - 分析全程在本机进行（object URL + 浏览器内模型），不上传帧、不调服务端算力
 *  - v3.39 新增「从服务器载入」：手机拍片可先传服务器（HEVC 等自动转码或免转码直通），
 *    拉回 blob 后仍走本机分析；「载入视频」本地文件路径保持不变（零上传）
 *  - AI 只产「候选」，类型恒为弱建议，必须人工逐条确认后才落库
 *  - 落入要素时 desc 强制非空（后端 V1 要求），时间链按顺序累加重排（避开 V2 同手重叠）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fetchVideoBlob, type Element, type Station } from '../api';
import { TYPE_DEFAULTS } from '../constants';
import { analyzeVideo } from '../ai-segment/segmentation';
import { analyzeMotion, MOTION_SAMPLE_MS } from '../ai-segment/motion';
import { HAND_LABEL, DEFAULT_ROI, type AnalyzePhase, type Hand, type Roi, type RoiZone, type Tier } from '../ai-segment/types';
import { alignSop, type SopAlignResult, type SopStep } from '../ai-segment/sop';
import { useAuth } from '../auth';
import SelectMenu from '../components/SelectMenu';

const PPS = 60; // 时间线像素/秒（与工作台一致，便于对照）
const VIDEO_ACCEPT = 'video/*,.mp4,.mov,.webm,.mkv,.avi,.flv,.m4v';

/** v3.39：浏览器原生容器扩展名白名单——只有这些敢走「免转码直通」上传。
 *  MKV/AVI/FLV/WMV/TS/RMVB 一律转码（v3.28 教训：H.264-in-MKV  Chrome 解不了，
 *  ffmpeg 还把 mkv/webm 都报成 matroska，只能靠扩展名一刀切）。 */
const NATIVE_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', '3gp']);

/** 该文件是否敢让服务器免转码直通：扩展名在白名单 + canPlayType 不拒绝。
 *  拿不准返回 false → 走后端转码保底（多等几分钟，但保证能播）。 */
function browserCanPlay(file: File): boolean {
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  if (!NATIVE_EXTS.has(ext)) return false;
  try {
    const v = document.createElement('video');
    const t = file.type || (ext === 'webm' ? 'video/webm' : 'video/mp4');
    const r = v.canPlayType(t);
    return r === 'probably' || r === 'maybe';
  } catch { return false; }
}

/**
 * 检测方式（v3.37 新增，二选一，不改变页面其余交互）
 *
 * motion：帧间运动能量。真实工位实测更稳（戴手套不影响），但手别只能给建议值。
 * hand  ：MediaPipe 手部关键点。能出手别确定值，但只在裸手/近景可靠；
 *         实测戴手套车间视频检出率仅 34–38%，会切碎并大段漏检。
 * 默认 motion —— 车间现场戴手套是常态。选择按工位记住，不跨站。
 */
type Detector = 'motion' | 'hand';
const DETECTOR_KEY = 'ai-seg-detector';

const DETECTOR_HINT: Record<Detector, string> = {
  motion: '按画面运动能量切分：戴手套、远景都稳，不依赖手部识别；手别是建议值，需你确认。',
  hand: '按手部关键点切分：能给出确定手别，但要求画面里手清晰、最好不戴手套。',
};

/** 候选行的可编辑投影：候选本身不可变，要素参数在这里编辑 */
interface Row {
  id: string;
  start_ms: number;
  end_ms: number;
  hand: Hand;
  conf: number;
  tier: Tier;
  /** 建议类型（v3.38：运动学规则分类给出；一期手部关键点恒「其他」；人可改） */
  type: string;
  /** 要素描述：后端 V1 强制非空。v3.38 按标准库 format 模板生成骨架，人补对象/位置 */
  desc: string;
  /** 是否纳入本次写入 */
  include: boolean;
  /** 低置信原因 */
  reason?: string;
  /** v3.43 浪费规则直判提示（等待/双手不平衡，规则读段特征，只提示人工终裁） */
  waste?: string[];
  /** v3.44 P2-1 HOI 对象/位置建议（起点/终点驻留子区名；仅提示，随 desc 骨架实例化） */
  object?: string;
  dest?: string;
  /** v3.44 P2-2 SOP 对齐结果提示（match/漏步/重复/SOP外；只提示不定罪） */
  sop?: string;
  /** 描述是否为机器生成态（骨架/HOI/SOP 自动命名可覆盖；用户手改后永不被覆盖） */
  autoDesc: boolean;
  /** 与现有要素时间重叠（仅提示，不自动排除） */
  overlaps: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;const durOf = (r: Row) => Math.max(0.1, round2((r.end_ms - r.start_ms) / 1000));

/** v3.43 解析工位 roi 列（JSON 字符串）；不合法/为空返回 null（回退内置默认） */
function parseRoi(s: string | null | undefined): Roi | null {
  if (!s) return null;
  try {
    const j = JSON.parse(s);
    const nums = [j?.x, j?.y, j?.w, j?.h];
    if (nums.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) return null;
    return { x: j.x, y: j.y, w: j.w, h: j.h };
  } catch { return null; }
}

/** v3.44 P2-1 解析工位 roi_zones 列（JSON 数组）；不合法/为空返回 null（HOI 关闭） */
function parseZones(s: string | null | undefined): RoiZone[] | null {
  if (!s) return null;
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const zones: RoiZone[] = [];
    for (const z of arr) {
      const name = String(z?.name ?? '').trim();
      const nums = [z?.x, z?.y, z?.w, z?.h];
      if (!name || nums.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
      zones.push({ name, x: z.x, y: z.y, w: z.w, h: z.h });
    }
    return zones.length ? zones : null;
  } catch { return null; }
}

/** v3.44 P2-2 解析工位 sop_steps 列；不合法返回空数组 */
function parseSopSteps(s: string | null | undefined): SopStep[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((it) => ({ verb: String(it?.verb ?? '').trim(), object: it?.object ? String(it.object).trim() : undefined }))
      .filter((it) => it.verb);
  } catch { return []; }
}

/** ROI 人类可读（百分比一位小数） */
const roiText = (r: Roi) =>
  `x ${Math.round(r.x * 1000) / 10}% · y ${Math.round(r.y * 1000) / 10}% · ${Math.round(r.w * 1000) / 10}%×${Math.round(r.h * 1000) / 10}%`;

/**
 * v3.43 证据帧抓取（P1-1）：离屏 <video> 逐时刻 seek → canvas → JPEG dataURL。
 * 用独立离屏元素，不碰主播放器的播放位置（现场习惯「填完按 L 播视频」不能被打断）。
 * 证据帧只在本次会话内存中展示，不上传、不落库（与视频零上传边界一致）。
 */
async function captureFrames(videoUrl: string, timesMs: number[]): Promise<string[]> {
  const v = document.createElement('video');
  v.src = videoUrl;
  v.muted = true;
  v.preload = 'auto';
  v.style.position = 'fixed';
  v.style.left = '-9999px';
  document.body.appendChild(v);
  try {
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('视频元数据加载超时')), 8000);
      v.addEventListener('loadeddata', () => { clearTimeout(timer); res(); }, { once: true });
      v.addEventListener('error', () => { clearTimeout(timer); rej(new Error('视频加载失败')); }, { once: true });
    });
    const vw = v.videoWidth || 640;
    const vh = v.videoHeight || 360;
    const W = 320;
    const H = Math.max(60, Math.round((W * vh) / vw));
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('无法创建截图画布');
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const out: string[] = [];
    for (const tMs of timesMs) {
      const t = dur ? Math.min(Math.max(tMs / 1000, 0), dur - 0.05) : tMs / 1000;
      await new Promise<void>((res) => {
        let done = false;
        const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); res(); };
        v.addEventListener('seeked', fin);
        setTimeout(fin, 1200);
        try { v.currentTime = t; } catch { fin(); }
      });
      ctx.drawImage(v, 0, 0, W, H);
      out.push(cv.toDataURL('image/jpeg', 0.72));
    }
    return out;
  } finally {
    v.remove();
  }
}

/**
 * 标准库描述格式模板（v3.38）：分析前从 motion_standard 规则集拉取，
 * key=类型名（一级或二级），value=format 字符串（如「拿取 +对象于 +位置 +距离」）。
 * 拉不到（权限/网络）保持空表 —— descSkeleton 自动退化为类型前缀。
 * 注意：缓存是模块级普通变量（非 hook）；拉取动作在组件内用 useEffect 触发。
 */
let FORMAT_TPL: Record<string, string> = {};

async function loadFormatTpl(): Promise<void> {
  try {
    const res: any = await api.rules.content('motion_standard');
    const c = res?.content;
    if (!c?.groups) return;
    const tpl: Record<string, string> = {};
    for (const g of c.groups) {
      if (g.format) tpl[g.level1] = g.format;
      for (const s of g.subs ?? []) if (s.format) tpl[s.level2] = s.format;
    }
    FORMAT_TPL = tpl;
  } catch { /* 拉不到就用退化骨架，不阻塞分析 */ }
}

/**
 * 描述骨架（v3.38）：按公司标准库 motion_standard 的 format 模板生成。
 * 模板形如「拿取 +对象于 +位置 +距离」：+ 后是待填字段，人只替换 +xxx 占位即可，
 * 与分解工作台的描述规范完全一致（同一个标准库，同一套写法）。
 * 标准库拉不到时退化为「{类型}：」前缀，仍满足 V1 非空。
 *
 * v3.44 P2：骨架可**实例化**——object 填进含「对象」的字段、dest 填进含「位置」的字段
 * （HOI 状态机建议 / SOP 命中步骤的期望对象）。没值的字段保持空括号待人工填。
 */
function descFill(type: string, object: string | undefined, dest: string | undefined, id?: string): string {
  const fmt = FORMAT_TPL[type];
  if (!fmt) {
    // 无模板：有建议值就带上，仍是合法非空描述
    const seg: string[] = [];
    if (object) seg.push(`对象：${object}`);
    if (dest) seg.push(`位置：${dest}`);
    return seg.length ? `${type}[${seg.join('][')}]` : `${type}：`;
  }
  const parts = fmt.split('+').map((s) => s.trim()).filter(Boolean);
  const head = parts[0] || type;
  const fields = parts.slice(1).map((f) => {
    if (object && f.includes('对象')) return `[${f}：${object}]`;
    if (dest && f.includes('位置')) return `[${f}：${dest}]`;
    return `[${f}：]`;
  }).join('');
  return `${head}${fields}` || `${type}（${id}）：`;
}

/**
 * 读取视频真实时长。
 * MediaRecorder / 部分录屏产出的 WebM 的 duration 是 Infinity（无时长元数据），
 * 此时 seek 到一个极大值可让浏览器把时长算出来（浏览器 quirk 的标准解法）。
 * 兜底用 seekable 末尾；都取不到返回 0，由调用方给出明确提示而不是静默失败。
 */
function resolveDuration(v: HTMLVideoElement): Promise<number> {
  const d = v.duration;
  if (Number.isFinite(d) && d > 0) return Promise.resolve(d);
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (val: number) => {
      if (settled) return;
      settled = true;
      v.removeEventListener('timeupdate', onUpdate);
      v.removeEventListener('durationchange', onUpdate);
      clearTimeout(timer);
      try { v.currentTime = 0; } catch { /* 某些格式 seek 回去会抛，忽略 */ }
      resolve(Number.isFinite(val) && val > 0 ? val : 0);
    };
    const onUpdate = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) finish(v.duration);
    };
    timer = setTimeout(() => {
      const s = v.seekable && v.seekable.length ? v.seekable.end(v.seekable.length - 1) : 0;
      finish(s);
    }, 4000);
    v.addEventListener('timeupdate', onUpdate);
    v.addEventListener('durationchange', onUpdate);
    try { v.currentTime = 1e6; } catch { finish(0); }
  });
}

export default function AiSegmentPage({ stationId }: { stationId: string }) {
  const { can } = useAuth();
  const [station, setStation] = useState<Station | null>(null);
  const [existing, setExisting] = useState<Element[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string | null>(null);
  /** v3.39：当前视频来源（local=本机文件零上传 / server=服务器上传拉回） */
  const [videoFrom, setVideoFrom] = useState<'local' | 'server' | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [playhead, setPlayhead] = useState(0);

  const [rows, setRows] = useState<Row[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [phase, setPhase] = useState<AnalyzePhase>('load');
  const [progress, setProgress] = useState({ processedMs: 0, totalMs: 0, detected: 0 });
  const [analyzed, setAnalyzed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipCovered, setSkipCovered] = useState(false);
  const [detector, setDetector] = useState<Detector>(() => {    try { return localStorage.getItem(DETECTOR_KEY) === 'hand' ? 'hand' : 'motion'; } catch { return 'motion'; }
  });
  /** 切换检测方式：另一种算法的结果不能混用，故连同结果一起清空 */
  const pickDetector = (d: Detector) => {
    setDetector(d);
    setRows([]); setAnalyzed(false); setError(null); setSaved(null); setAlignRes(null);
    try { localStorage.setItem(DETECTOR_KEY, d); } catch { /* 隐私模式忽略 */ }
  };

  const [cycles, setCycles] = useState(15);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  /** v3.41（用户修正）：AI 写入一律开新版本，禁止与手工分解数据混在同一版本 */
  const canRetest = can('station:retest');

  /* ── v3.43 P1：操作区 ROI 逐工位标定 ── */
  const [roiPanel, setRoiPanel] = useState(false);
  /** 当前生效 ROI（工位 roi 列；null=未标定用内置默认） */
  const [roiDraft, setRoiDraft] = useState<Roi | null>(null);
  /** 面板内拖拽中的临时矩形 */
  const [dragRect, setDragRect] = useState<Roi | null>(null);
  const [roiBusy, setRoiBusy] = useState(false);
  const [roiMsg, setRoiMsg] = useState<string | null>(null);
  const videoBoxRef = useRef<HTMLDivElement | null>(null);

  /* ── v3.44 P2-1：功能区子区（HOI 对象层） ── */
  /** 子区草稿（坐标相对 ROI）；null=未动过（保存时不发字段，保留库内原值） */
  const [zonesDraft, setZonesDraft] = useState<RoiZone[] | null>(null);
  /** 覆盖层「画子区」模式：拖拽产出的矩形按当前 ROI 归一化 */
  const [zoneMode, setZoneMode] = useState(false);
  /** 画完待命名的子区 */
  const [pendingZone, setPendingZone] = useState<RoiZone | null>(null);
  const [zoneName, setZoneName] = useState('');

  /* ── v3.44 P2-2：SOP 对齐（封闭词表自动命名） ── */
  const [sopPanel, setSopPanel] = useState(false);
  const [sopDraft, setSopDraft] = useState<SopStep[]>([]);
  const [sopBusy, setSopBusy] = useState(false);
  const [sopMsg, setSopMsg] = useState<string | null>(null);
  const [alignRes, setAlignRes] = useState<SopAlignResult | null>(null);

  /* ── v3.43 P1：证据帧 ── */
  const [evi, setEvi] = useState<{ id: string; times: number[]; urls: string[] | null; err?: string } | null>(null);

  /* ── v3.53 场景切分候选（服务端 ffmpeg 检测；仅「从服务器载入」的视频可用，零 LLM） ── */
  const [sceneScenes, setSceneScenes] = useState<{ start_ms: number; end_ms: number; score: number }[] | null>(null);
  const [sceneBusy, setSceneBusy] = useState(false);
  /* 服务器视频的落盘文件名（uuid.mp4）——scene-detect 校验此名；videoName 是给人看的 label，二者分离 */
  const [serverFileName, setServerFileName] = useState<string | null>(null);
  const runSceneDetect = async () => {
    if (videoFrom !== 'server' || !serverFileName) return;
    setSceneBusy(true); setError(null);
    try {
      const res = await api.sceneDetect(serverFileName);
      setSceneScenes(res.scenes);
    } catch (e: any) {
      setError(`场景切分检测失败：${e?.message ?? e}`);
      setSceneScenes(null);
    } finally {
      setSceneBusy(false);
    }
  };

  const showEvidence = async (r: Row) => {
    if (!videoUrl) return;
    const times = [r.start_ms + 80, Math.round((r.start_ms + r.end_ms) / 2), Math.max(0, r.end_ms - 80)];
    setEvi({ id: r.id, times, urls: null });
    try {
      const urls = await captureFrames(videoUrl, times);
      setEvi((prev) => (prev && prev.id === r.id ? { ...prev, urls } : prev));
    } catch (e: any) {
      setEvi((prev) => (prev && prev.id === r.id ? { ...prev, err: e?.message ?? '抓帧失败' } : prev));
    }
  };

  /** 保存/清除工位标定（ROI + 功能区子区一起提交；zonesDraft===null 表示未动过不发字段）。
   *  需 station:write 资源级权限；viewer 会得到 403 提示。
   *  v3.44：坐标四舍五入到 4 位小数——拖拽浮点噪声曾顶爆 roi 64 字符上限（400 实锤）。 */
  const saveCalibration = async (roi: Roi | null, zones: RoiZone[] | null | undefined) => {
    setRoiBusy(true); setRoiMsg(null);
    try {
      const r4 = (v: number) => Math.round(v * 10000) / 10000;
      const payload: { roi?: string | null; roi_zones?: string | null } = {};
      payload.roi = roi ? JSON.stringify({ x: r4(roi.x), y: r4(roi.y), w: r4(roi.w), h: r4(roi.h) }) : null;
      if (zones !== undefined) {
        payload.roi_zones = zones && zones.length
          ? JSON.stringify(zones.map((z) => ({ name: z.name, x: r4(z.x), y: r4(z.y), w: r4(z.w), h: r4(z.h) })))
          : null;
      }
      const st = await api.updateStation(stationId, payload);
      setStation(st);
      setRoiDraft(parseRoi(st.roi));
      if (payload.roi_zones !== undefined) setZonesDraft(parseZones(st.roi_zones));
      // 消息按「实际提交了什么」如实回告（只存子区时不得误报"已清除标定"——v344 测试实锤）
      const savedZones = payload.roi_zones !== undefined;
      if (roi) setRoiMsg(`已保存到工位：${roiText(roi)}${savedZones ? '；功能区子区已更新' : ''}`);
      else if (savedZones) setRoiMsg(zones && zones.length ? '功能区子区已保存到工位（操作区未标定，用内置默认）' : '已清除功能区子区（操作区未标定，用内置默认）');
      else setRoiMsg('已清除标定，回退内置默认操作区');
    } catch (e: any) {
      setRoiMsg(`保存失败：${e?.message ?? e}`);
    } finally {
      setRoiBusy(false);
    }
  };

  /** 视频画面实际内容矩形（letterbox 后）：把指针坐标换算成归一化视频坐标 */
  const videoContentRect = () => {
    const box = videoBoxRef.current;
    const v = videoRef.current;
    if (!box || !v || !v.videoWidth || !v.videoHeight) return null;
    const r = box.getBoundingClientRect();
    const ar = v.videoWidth / v.videoHeight;
    let w = r.width;
    let h = r.height;
    if (w / h > ar) w = h * ar; else h = w / ar;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h };
  };

  /** 拖拽框选：pointer 事件 → 归一化 ROI（钳 0–1，最小 0.05） */
  const roiDragRef = useRef<{ x0: number; y0: number } | null>(null);
  const roiPointerPos = (e: React.PointerEvent) => {
    const rect = videoContentRect();
    if (!rect) return null;
    const nx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.w));
    const ny = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.h));
    return { nx, ny };
  };
  const onRoiDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = roiPointerPos(e);
    if (!p) return;
    roiDragRef.current = { x0: p.nx, y0: p.ny };
    setDragRect({ x: p.nx, y: p.ny, w: 0, h: 0 });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onRoiMove = (e: React.PointerEvent) => {
    const st = roiDragRef.current;
    if (!st) return;
    const p = roiPointerPos(e);
    if (!p) return;
    setDragRect({
      x: Math.min(st.x0, p.nx),
      y: Math.min(st.y0, p.ny),
      w: Math.abs(p.nx - st.x0),
      h: Math.abs(p.ny - st.y0),
    });
  };
  const onRoiUp = () => {
    const rect = dragRect;
    roiDragRef.current = null;
    setDragRect(null);
    if (!rect || rect.w < 0.05 || rect.h < 0.05) return;
    if (zoneMode) {
      // v3.44 P2-1：子区模式——画布矩形换算为「相对当前 ROI」坐标，进命名流程
      const eff = roiDraft ?? DEFAULT_ROI;
      const zx = Math.min(1, Math.max(0, (rect.x - eff.x) / eff.w));
      const zy = Math.min(1, Math.max(0, (rect.y - eff.y) / eff.h));
      const zw = Math.min(1 - zx, rect.w / eff.w);
      const zh = Math.min(1 - zy, rect.h / eff.h);
      if (zw < 0.02 || zh < 0.02) {
        setRoiMsg('子区太小（相对操作区宽高须 ≥2%），请框大一点');
        return;
      }
      setPendingZone({ name: '', x: zx, y: zy, w: zw, h: zh });
      setZoneName('');
      setRoiMsg(null);
      return;
    }
    setRoiDraft({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
    setRoiMsg(`已框选：${roiText({ x: rect.x, y: rect.y, w: rect.w, h: rect.h })}（点「保存到工位」长期生效）`);
  };

  /** v3.44 P2-1：确认命名子区（名称必填且不与现有重名） */
  const confirmZone = () => {
    const z = pendingZone;
    const name = zoneName.trim();
    if (!z || !name) return;
    if ((zonesDraft ?? []).some((x) => x.name === name)) {
      setRoiMsg(`子区名称重复：「${name}」`);
      return;
    }
    setZonesDraft([...(zonesDraft ?? []), { ...z, name }]);
    setPendingZone(null);
    setZoneName('');
    setRoiMsg(`子区「${name}」已加入（点「保存到工位」长期生效）`);
  };

  /** ROI 覆盖层对齐视频内容框（letterbox 后）：拖拽坐标与矩形显示共用同一坐标系 */
  const [roiLayerBox, setRoiLayerBox] = useState<React.CSSProperties | null>(null);
  useEffect(() => {
    if (!roiPanel) { setRoiLayerBox(null); return; }
    const compute = () => {
      const box = videoBoxRef.current;
      const v = videoRef.current;
      if (!box || !v || !v.videoWidth) { setRoiLayerBox(null); return; }
      const cr = videoContentRect();
      if (!cr) { setRoiLayerBox(null); return; }
      const br = box.getBoundingClientRect();
      setRoiLayerBox({
        position: 'absolute',
        left: cr.left - br.left,
        top: cr.top - br.top,
        width: cr.w,
        height: cr.h,
      });
    };
    compute();
    const t = setTimeout(compute, 400); // 视频布局稳定后复核一次
    window.addEventListener('resize', compute);
    return () => { clearTimeout(t); window.removeEventListener('resize', compute); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roiPanel, videoUrl, durationMs]);

  /* v3.39：服务器视频载入（上传 → 拉 blob → object URL，分析仍在本机） */
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  /** 免转码直通的服务器视频若在本机播不了，记下源文件做一次转码重试 */
  const serverRetryRef = useRef<{ file: File; raw: boolean } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /* ── 加载工位与现有要素（用 station + elements 两个只读接口，不依赖 analysis:read） ── */
  const load = useCallback(async () => {
    try {
      const [st, els] = await Promise.all([api.station(stationId), api.elements(stationId)]);
      setStation(st);
      setExisting(els.elements ?? []);
      setRoiDraft(parseRoi(st.roi));   // v3.43：工位已标定的操作区
      setZonesDraft(parseZones(st.roi_zones));   // v3.44 P2-1：功能区子区
      setSopDraft(parseSopSteps(st.sop_steps));  // v3.44 P2-2：SOP 步骤序列
      setLoadErr(null);
    } catch (e: any) {
      setLoadErr(e?.message ?? '工位加载失败');
    }
  }, [stationId]);
  useEffect(() => { void load(); }, [load]);
  /* 标准库描述格式模板（v3.38）：进页面拉一次，供候选描述骨架用 */
  useEffect(() => { void loadFormatTpl(); }, []);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const pickVideo = (file?: File) => {
    if (!file) return;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setVideoUrl(url);
    setVideoName(file.name);
    setVideoFrom('local');
    setServerFileName(null);
    setRows([]); setAnalyzed(false); setError(null); setSaved(null); setConfirming(false); setAlignRes(null);
  };

  /** 把服务器视频安进来：拉 blob → object URL（与本地文件同一条分析链路） */
  const applyServerVideo = async (url: string, label: string, retry: { file: File; raw: boolean } | null, serverName?: string) => {
    const blob = await fetchVideoBlob(url);
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const objUrl = URL.createObjectURL(blob);
    objectUrlRef.current = objUrl;
    serverRetryRef.current = retry;
    setVideoUrl(objUrl);
    setVideoName(label);
    setVideoFrom('server');
    setServerFileName(serverName ?? null);
    setRows([]); setAnalyzed(false); setConfirming(false); setAlignRes(null);
  };

  /** v3.39：从服务器载入（手机拍片 → 上传 → 分析）。上传带进度；传完服务端还要探测/转码。 */
  const pickServerVideo = async (file?: File) => {
    if (!file || uploading) return;
    setUploading(true); setUploadPct(0);
    setError(null); setSaved(null); setConfirming(false);
    try {
      const raw = browserCanPlay(file);
      const handle = await api.videos.uploadWithProgress(file, setUploadPct, raw);
      const label = `${file.name}（服务器${handle.transcoded ? '已转码' : '直通'} · ${handle.probe.width}×${handle.probe.height}${handle.probe.durationS != null ? ` · ${handle.probe.durationS.toFixed(1)}s` : ''}）`;
      await applyServerVideo(handle.url, label, { file, raw }, handle.name);
    } catch (e: any) {
      setError(`服务器载入失败：${e?.message ?? e}。大文件可改走「载入视频」选本地文件（零上传）。`);
    } finally {
      setUploading(false);
    }
  };

  /** 免转码直通的视频若在本机播不了（老浏览器无 HEVC 解码），自动请求服务端转码重试一次 */
  const onVideoError = async () => {
    const cur = serverRetryRef.current;
    if (!cur || !cur.raw || uploading) return;
    setError('该浏览器无法直接播放此视频编码，正在请求服务器转码（稍候）…');
    try {
      const handle = await api.videos.uploadWithProgress(cur.file, undefined, false);
      await applyServerVideo(handle.url, `${cur.file.name}（服务器已转码）`, null, handle.name);
      setError(null);
    } catch (e: any) {
      setError(`转码重试失败：${e?.message ?? e}。请改用本地 MP4(H.264) 文件。`);
    }
  };

  /** 现有要素区间（可选用于跳过已覆盖时段） */
  const covered = useMemo(
    () => existing.map((el) => ({ start_ms: el.start_ms, end_ms: el.start_ms + Math.round(el.dur_s * 1000) })),
    [existing],
  );

  const run = async () => {
    const v = videoRef.current;
    if (!v || !videoUrl) { setError('请先载入视频，再开始分析'); return; }
    setError(null); setSaved(null); setConfirming(false);
    setRows([]); setAnalyzed(false);
    setAnalyzing(true); setPhase('load');
    setProgress({ processedMs: 0, totalMs: 0, detected: 0 });
    const ac = new AbortController();
    abortRef.current = ac;
    v.pause();
    try {
      // 时长先解析（WebM 常见 Infinity），拿到真实值后再驱动抽帧
      const dur = await resolveDuration(v);
      if (!dur) {
        throw new Error('无法读取视频时长：该文件可能缺少时长元数据。请换用 MP4，或先重新封装。');
      }
      const totalMs = Math.round(dur * 1000);
      setDurationMs(totalMs);
      setProgress({ processedMs: 0, totalMs, detected: 0 });
      const opts = {
        reserved: skipCovered ? covered : [],
        roi: roiDraft ?? undefined,   // v3.43：逐工位操作区（未标定回退内置默认）
        zones: zonesDraft ?? undefined,   // v3.44 P2-1：功能区子区（HOI 对象层；未配置=关闭）
        signal: ac.signal,
        onProgress: (p: { phase: AnalyzePhase; processedMs: number; totalMs: number; detected: number }) => {
          setPhase(p.phase);
          setProgress({ processedMs: p.processedMs, totalMs: p.totalMs, detected: p.detected });
        },
      };
      const res = detector === 'hand' ? await analyzeVideo(v, opts) : await analyzeMotion(v, opts);
      setRows(res.candidates.map((c) => {
        const overlaps = covered.some((r) => c.start_ms < r.end_ms && c.end_ms > r.start_ms);
        /* v3.38：类型直接采用算法建议（运动能量=运动学规则分类 / 手部关键点一期恒「其他」），
           页面不再覆盖为「其他」；描述用标准库 format 模板生成骨架。
           v3.44 P2-1：HOI 对象/位置建议实例化进骨架（人工仍可改写，改写即「手改优先」）。 */
        return {
          id: c.id, start_ms: c.start_ms, end_ms: c.end_ms, hand: c.hand, conf: c.conf, tier: c.tier,
          type: c.type, desc: descFill(c.type, c.object, c.dest, c.id), include: c.tier !== 'low',
          reason: c.reason, overlaps, waste: c.wasteHints, object: c.object, dest: c.dest, autoDesc: true,
        };
      }));
      setAnalyzed(true);
    } catch (e: any) {
      if (e?.name === 'AbortError') setError('已停止分析（已完成的部分未保留）');
      else setError(`分析失败：${e?.message ?? e}。可重试；若反复失败，请确认使用 Chrome/Edge 且已开启硬件加速。`);
    } finally {
      setAnalyzing(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const patch = (id: string, p: Partial<Row>) => setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...p } : r)));
  /** 描述编辑 = 用户手改（机器自动命名从此不再覆盖这条） */
  const patchDesc = (id: string, desc: string) => patch(id, { desc, autoDesc: false });

  const included = rows.filter((r) => r.include).sort((a, b) => a.start_ms - b.start_ms);
  const totalDur = round2(included.reduce((s, r) => s + durOf(r), 0));
  const maxEnd = existing.reduce((m, el) => Math.max(m, el.start_ms + Math.round(el.dur_s * 1000)), 0);

  /** 构建提交载荷：AI 候选按顺序累加重排时间链（v3.41：只含 AI 要素，不再拼入手工要素） */
  const buildPayload = () => {
    const base: { seq: number; start_ms: number; dur_s: number; hand: string; type: string; desc: string; va_class: string; outlier_flag: number; outlier_reason: string; rating: number; allowance: number; source?: 'ai_assisted' | 'manual' }[] = [];
    let cursor = 0;
    for (const r of included) {
      const dur = durOf(r);
      base.push({
        seq: 0, start_ms: cursor, dur_s: dur, hand: r.hand, type: r.type,
        desc: r.desc.trim() || `AI 候选${r.id.slice(1)}`,
        va_class: TYPE_DEFAULTS[r.type] ?? 'RNVA',
        outlier_flag: 0, outlier_reason: '', rating: 1, allowance: 0.15, source: 'ai_assisted',
      });
      cursor += Math.round(dur * 1000);
    }
    return base.map((el, i) => ({ ...el, seq: i + 1 }));
  };

  /**
   * v3.41 写入（用户修正：AI 分解结果不得写入手工分解工作台的数据）：
   * 一律「封存当前版本 → 开新版本 → 提交 AI 要素」三步——AI 要素独占新版本，
   * 手工要素留在原版本只读封存，两个分解方式的数据完全隔离互不覆盖。
   * 当前版本无要素时无需复测（本来就是空版），直接写入当前版本。
   */
  const doWrite = async () => {
    if (!station || included.length === 0) return;
    setSaving(true); setError(null);
    try {
      let version = station.version;
      if (existing.length > 0) {
        const st = await api.startRetest(stationId);   // 封存旧版 + version+1（服务端有空版本护栏）
        version = st.version;
      }
      const payload = buildPayload();
      const res = await api.submitElements(stationId, {
        bol_version: version, cycle_count: cycles, cv: 0, video_id: 'ai-segment', elements: payload,
      });
      setSaved(`已写入 v${res.version}（新版本，AI 分解独立版）：要素 ${res.element_count} 条，CT ${res.ct}s。原手工分解数据在 v${station.version} 只读封存互不影响。可前往分解工作台切换版本查看，或直接运行「浪费识别」。`);
      setConfirming(false);
      await load();
    } catch (e: any) {
      const errs = e?.body?.errors ?? e?.errors;
      setError(Array.isArray(errs) && errs.length
        ? `写入被校验拦截：${errs.slice(0, 3).map((x: any) => x.message).join('；')}`
        : `写入失败：${e?.message ?? e}`);
      // 复测已开新版本但提交失败时刷新工位态，避免版本号错位
      await load();
    } finally {
      setSaving(false);
    }
  };

  /** v3.44 P2-2：SOP 步骤保存到工位（verb 封闭词表由后端 motion_standard 校验） */
  const saveSop = async () => {
    const steps = sopDraft
      .map((s) => ({ verb: s.verb.trim(), object: s.object?.trim() || undefined }))
      .filter((s) => s.verb) as SopStep[];
    if (new Set(steps.map((s) => s.verb + '|' + (s.object ?? ''))).size !== steps.length) {
      setSopMsg('存在完全重复的步骤（动词+对象），请去重后再保存');
      return;
    }
    setSopBusy(true); setSopMsg(null);
    try {
      const st = await api.updateStation(stationId, { sop_steps: steps.length ? JSON.stringify(steps) : null });
      setStation(st);
      setSopDraft(parseSopSteps(st.sop_steps));
      setSopMsg(steps.length ? `已保存 ${steps.length} 步 SOP 到工位（动词已按动作标准库词表校验）` : '已清空 SOP 步骤');
    } catch (e: any) {
      setSopMsg(`保存失败：${e?.message ?? e}`);
    } finally {
      setSopBusy(false);
    }
  };

  /**
   * v3.44 P2-2：SOP 序列对齐（LCS）。
   * 命中步骤的候选自动命名（动词来自 SOP、对象=SOP 期望对象，HOI 位置保留）——
   * 只覆盖机器生成态描述（autoDesc），用户手改的描述永不被覆盖；漏步/重复/SOP 外只提示不定罪。
   */
  const runAlign = () => {
    const steps = sopDraft.filter((s) => s.verb.trim());
    if (!steps.length) { setSopMsg('请先添加并保存 SOP 步骤，再执行对齐'); return; }
    const cands = [...rows]
      .sort((a, b) => a.start_ms - b.start_ms)
      .map((r) => ({ id: r.id, type: r.type, start_ms: r.start_ms }));
    const res = alignSop(cands, steps);
    setAlignRes(res);
    setRows((prev) => prev.map((r) => {
      const it = res.byCand.get(r.id);
      if (!it) return { ...r, sop: undefined };
      if (it.kind === 'match' && it.stepIdx != null) {
        const step = steps[it.stepIdx];
        const obj = step.object || r.object;
        return {
          ...r,
          sop: it.label,
          type: step.verb,
          desc: r.autoDesc ? descFill(step.verb, obj, r.dest, r.id) : r.desc,
        };
      }
      return { ...r, sop: it.label };
    }));
    setSopMsg(null);
  };

  /** v3.43 导出候选 JSON（评测基线用）：与人工标注真值跑 eval 脚本，回答「准不准」 */
  const exportCandidates = () => {
    const data = {
      station_id: stationId,
      exported_at: new Date().toISOString(),
      video_name: videoName,
      video_from: videoFrom,
      detector,
      roi: roiDraft ?? DEFAULT_ROI,
      roi_calibrated: Boolean(roiDraft),
      roi_zones: zonesDraft ?? undefined,
      sop_steps: sopDraft.length ? sopDraft : undefined,
      duration_ms: durationMs,
      sample_ms: MOTION_SAMPLE_MS,
      candidates: [...rows].sort((a, b) => a.start_ms - b.start_ms).map((r) => ({
        id: r.id, start_ms: r.start_ms, end_ms: r.end_ms, hand: r.hand,
        conf: r.conf, tier: r.tier, type: r.type, desc: r.desc,
        object: r.object, dest: r.dest, sop: r.sop,
        waste_hints: r.waste ?? [],
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-candidates-${stationId}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const seekTo = (ms: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min((durationMs || 0) / 1000, ms / 1000));
    setPlayhead(Math.max(0, ms));
  };

  if (loadErr) return <div className="card empty">工位 {stationId} 加载失败：{loadErr}</div>;

  return (
    <div className="aip">
      <div className="aip-head">
        <div className="aip-title">
          <h2>AI 自动分解</h2>
          <span className="aip-meta mono">
            {stationId} · v{station?.version ?? '—'} · 现有要素 {existing.length} 条
          </span>
        </div>
        <div className="aip-acts">
          <label className="btn sm">
            {videoUrl ? '更换视频' : '载入视频'}
            <input type="file" accept={VIDEO_ACCEPT} style={{ display: 'none' }} aria-label="选择本地视频文件"
              onChange={(e) => { pickVideo(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <label className={`btn sm${uploading ? ' is-busy' : ''}`}
            title="手机拍片先传服务器再分析：上传后拉回本机分析，页面不外传帧。HEVC 等格式服务端自动转码（或免转码直通）">
            {uploading ? (uploadPct >= 100 ? '服务器处理中…' : `上传 ${uploadPct}%`) : '从服务器载入'}
            <input type="file" accept={VIDEO_ACCEPT} style={{ display: 'none' }} aria-label="选择服务器上传视频" disabled={uploading}
              onChange={(e) => { pickServerVideo(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {analyzing ? (
            <button className="btn sm" onClick={stop}>停止分析</button>
          ) : (
            <button className="btn sm primary" onClick={() => void run()} disabled={!videoUrl || uploading}
              title={videoUrl ? (uploading ? '服务器视频载入中，请稍候' : '在本机分析当前视频，识别手部动作止点') : '请先载入视频'}>
              开始分析
            </button>
          )}
          <label className="aip-opt" title={DETECTOR_HINT[detector]}>
            检测方式
            {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
            <SelectMenu ariaLabel="检测方式" triggerClassName="aip-sel" disabled={analyzing}
              value={detector}
              onChange={(v) => pickDetector(v as Detector)}
              options={[
                { value: 'motion', label: '运动能量（推荐）' },
                { value: 'hand', label: '手部关键点' },
              ]} />
          </label>
          <button type="button" className={`btn sm${roiPanel ? ' primary' : ''}`} disabled={analyzing || !videoUrl}
            title="逐工位标定操作区：换机位/换工位必须重标（当前默认区只适配示范工位机位）"
            onClick={() => { setRoiPanel((p) => !p); setRoiMsg(null); }}>
            操作区{roiDraft ? '·已标定' : ''}
          </button>
          <button type="button" className={`btn sm${sopPanel ? ' primary' : ''}`} disabled={analyzing || !videoUrl}
            title="配置 SOP 期望步骤序列（封闭词表），候选按 LCS 对齐自动命名；漏步/重复/顺序异常只提示"
            onClick={() => { setSopPanel(true); setSopMsg(null); }}>
            SOP 对齐{sopDraft.length ? `·${sopDraft.length}步` : ''}
          </button>
          <label className="aip-opt" title="勾选后，现有要素已覆盖的时段不再生成候选（适合只补漏段）">
            <input type="checkbox" checked={skipCovered} onChange={(e) => setSkipCovered(e.target.checked)} disabled={analyzing} />
            跳过现有要素已覆盖时段
          </label>
          {videoFrom === 'server' && (
            <button type="button" className="btn sm" disabled={sceneBusy || !videoName}
              title="用服务端 ffmpeg 检测镜头切换点，给出候选片段起止（仅供参考，人工确认）"
              onClick={() => void runSceneDetect()}>
              {sceneBusy ? '检测中…' : '检测场景切分'}
            </button>
          )}
        </div>
      </div>

      <div className="aip-body">
        {/* ── 左：视频 + 时间线 ── */}
        <section className="aip-stage">
          <div className="aip-video" ref={videoBoxRef}>
            {videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                playsInline
                onError={() => void onVideoError()}
                onLoadedMetadata={(e) => {
                  const d = e.currentTarget.duration;
                  setDurationMs(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0);
                }}
                onTimeUpdate={(e) => setPlayhead(Math.round(e.currentTarget.currentTime * 1000))}
              />
            ) : (
              <div className="aip-video-empty">
                <p>载入一段工位视频（画面里要能看到手）</p>
                <p className="muted">
                  「载入视频」选本地文件，零上传、最快；手机拍片可走「从服务器载入」先传服务器。
                  <br />两种方式的**分析都在本机完成**，不占用服务器算力。
                </p>
              </div>
            )}

            {/* v3.43 ROI 覆盖层：主操作区 + v3.44 功能区子区 + 拖拽框选（面板打开时；对齐视频内容框） */}
            {roiPanel && videoUrl && !analyzing && (
              <div className="aip-roi-layer" style={roiLayerBox ?? undefined}
                onPointerDown={onRoiDown} onPointerMove={onRoiMove} onPointerUp={onRoiUp}>
                {/* 主操作区（拖拽中临时隐藏，避免与拖拽矩形叠影） */}
                {roiDraft && !dragRect && (
                  <div className="aip-roi-rect"
                    style={{ left: `${roiDraft.x * 100}%`, top: `${roiDraft.y * 100}%`, width: `${roiDraft.w * 100}%`, height: `${roiDraft.h * 100}%` }}>
                    <span>操作区</span>
                  </div>
                )}
                {/* v3.44 P2-1 功能区子区（坐标相对 ROI → 换算回画布显示） */}
                {(zonesDraft ?? []).map((z) => (() => {
                  const eff = roiDraft ?? DEFAULT_ROI;
                  return (
                    <div className="aip-zone-rect" key={z.name}
                      style={{
                        left: `${(eff.x + z.x * eff.w) * 100}%`,
                        top: `${(eff.y + z.y * eff.h) * 100}%`,
                        width: `${z.w * eff.w * 100}%`,
                        height: `${z.h * eff.h * 100}%`,
                      }}>
                      <span>{z.name}</span>
                    </div>
                  );
                })())}
                {/* 拖拽中的矩形（主 ROI / 子区两种样式） */}
                {dragRect && (
                  <div className={`aip-roi-rect${zoneMode ? ' zone' : ''}`}
                    style={{ left: `${dragRect.x * 100}%`, top: `${dragRect.y * 100}%`, width: `${dragRect.w * 100}%`, height: `${dragRect.h * 100}%` }}>
                    <span>{zoneMode ? '松开完成子区框选' : '松开完成框选'}</span>
                  </div>
                )}
              </div>
            )}

            {/* v3.43 ROI 面板 + v3.44 功能区子区 */}
            {roiPanel && (
              <div className="aip-roi-panel" role="dialog" aria-label="操作区标定">
                <b>操作区标定</b>
                <p className="muted">
                  当前：{roiDraft ? roiText(roiDraft) : `未标定（内置默认 ${roiText(DEFAULT_ROI)}）`}
                  <br />在视频画面上<b>拖拽</b>框出「手和物料活动的区域」，分析只看这块：噪声更小、边界更准。
                </p>

                <div className="aip-zones">
                  <b>功能区子区 <span className="muted" style={{ fontWeight: 400 }}>（HOI 对象层，v3.44）</span></b>
                  <p className="muted">
                    把物料/工具的<b>固定卡位</b>框成命名子区（如「扫码枪卡位」「料箱」）：
                    候选质心「进区停留→离开」即自动填描述的「对象」，终点子区填「位置」。
                  </p>
                  {(zonesDraft ?? []).map((z, i) => (
                    <div className="aip-zone-row" key={`${z.name}-${i}`}>
                      <b>{z.name}</b>
                      <span className="mono muted">
                        x{Math.round(z.x * 100)}% y{Math.round(z.y * 100)}% · {Math.round(z.w * 100)}%×{Math.round(z.h * 100)}%（相对操作区）
                      </span>
                      <button type="button" className="btn sm" disabled={roiBusy}
                        title="删除该子区（保存后生效）"
                        onClick={() => { setZonesDraft((zs) => (zs ?? []).filter((_, k) => k !== i) || null); setRoiMsg(null); }}>
                        删除
                      </button>
                    </div>
                  ))}
                  {!(zonesDraft ?? []).length && <p className="muted">尚未配置子区（不配置不影响分析，只是「对象」需人工填）</p>}
                  <div className="aip-roi-acts">
                    <button type="button" className={`btn sm${zoneMode ? ' primary' : ''}`} disabled={!!pendingZone}
                      onClick={() => { setZoneMode((m) => !m); setRoiMsg(null); }}>
                      {zoneMode ? '退出画子区' : '画子区'}
                    </button>
                  </div>
                  {pendingZone && (
                    <div className="aip-zone-pending">
                      <input className="aip-inp" value={zoneName} maxLength={20}
                        placeholder="子区名称，如：扫码枪卡位"
                        aria-label="子区名称"
                        onChange={(e) => setZoneName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') confirmZone(); }} />
                      <button type="button" className="btn sm primary" disabled={!zoneName.trim()} onClick={confirmZone}>确认</button>
                      <button type="button" className="btn sm" onClick={() => { setPendingZone(null); setZoneName(''); }}>取消</button>
                    </div>
                  )}
                </div>

                <div className="aip-roi-acts">
                  <button type="button" className="btn sm primary" disabled={roiBusy || !videoUrl}
                    onClick={() => void saveCalibration(roiDraft, zonesDraft)} title="保存操作区与子区到工位，之后所有分析都用此标定（需编辑权限）">
                    保存到工位
                  </button>
                  <button type="button" className="btn sm" disabled={roiBusy || !station?.roi}
                    onClick={() => void saveCalibration(null, zonesDraft)} title="清除操作区标定，回退内置默认（子区保留）">
                    清除标定
                  </button>
                  <button type="button" className="btn sm" onClick={() => { setRoiPanel(false); setZoneMode(false); setPendingZone(null); }}>关闭</button>
                </div>
                {roiMsg && <p className="aip-roi-msg">{roiMsg}</p>}
              </div>
            )}
            {analyzing && (
              <div className="ais-overlay" role="status" aria-live="polite">
                <h4>{phase === 'load' ? '正在加载本机视觉模型…' : phase === 'scan' ? '正在分析手部动作…' : '正在归并动作边界…'}</h4>
                {phase === 'load' ? (
                  <>
                    <div className="ais-sweep" aria-hidden="true" />
                    <p>首次约 2–4 秒（模型共 21MB，浏览器缓存后更快；无需外网）</p>
                  </>
                ) : (
                  <>
                    <div className="ais-progress" aria-hidden="true">
                      <i style={{ width: `${progress.totalMs > 0 ? Math.min(100, Math.round((progress.processedMs / progress.totalMs) * 100)) : 0}%` }} />
                    </div>
                    <p>
                      已处理 {(progress.processedMs / 1000).toFixed(1)}s / {(progress.totalMs / 1000).toFixed(1)}s
                      {phase === 'scan' ? ` · 手部检出 ${progress.detected} 帧` : ''}
                    </p>
                  </>
                )}
                <p>分析在本机进行（视觉模型跑在浏览器里，不占服务器）</p>
                <button type="button" className="btn sm" onClick={stop}>停止分析</button>
              </div>
            )}
          </div>

          {/* 简化时间线：只用于看候选落在视频哪里 + 点击定位（不可编辑，编辑在工作台） */}
          <div className="aip-tl-wrap">
            <div className="aip-tl-legend">
              <span>{uploading ? `服务器载入中 ${uploadPct}%` : (videoName ?? '未载入视频')}</span>
              <span className="mono">{durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : '—'}</span>
            </div>
            <div className="aip-tl-scroll">
              <div className="aip-tl" style={{ width: Math.max(320, (durationMs / 1000) * PPS), minWidth: '100%' }}
                onPointerDown={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  seekTo(Math.round(((e.clientX - rect.left) / PPS) * 1000));
                }}>
                {rows.map((r) => (
                  <div key={r.id}
                    className={`aip-cand hand-${r.hand} tier-${r.tier}${r.include ? '' : ' off'}${r.overlaps ? ' ov' : ''}`}
                    style={{ left: (r.start_ms / 1000) * PPS, width: Math.max(5, ((r.end_ms - r.start_ms) / 1000) * PPS - 2) }}
                    title={`${r.id} · ${HAND_LABEL[r.hand]} · ${(r.start_ms / 1000).toFixed(1)}→${(r.end_ms / 1000).toFixed(1)}s · 置信 ${r.conf}${r.overlaps ? ' · 与现有要素重叠' : ''}`}
                  >
                    <b>{r.id.toUpperCase()}</b>
                  </div>
                ))}
                <div className="aip-playhead" style={{ left: (playhead / 1000) * PPS }} />
                {durationMs === 0 && (
                  <div className="aip-tl-hint">载入视频后，候选分段按时间落在这条轨道上（点轨道可定位）</div>
                )}
              </div>
            </div>
          </div>

          {sceneScenes && (
            <div className="aip-scenes" role="status">
              <b>场景切分候选（{sceneScenes.length} 段 · 仅供参考，人工确认起止）：</b>
              <div className="aip-scenes-list">
                {sceneScenes.length === 0 && <span className="muted">未检出明显镜头切换（单一镜头视频）。</span>}
                {sceneScenes.map((s, i) => (
                  <button type="button" key={i} className="aip-scene" onClick={() => seekTo(s.start_ms)}
                    title={`${s.start_ms / 1000}s → ${s.end_ms / 1000}s`}>
                    {(s.start_ms / 1000).toFixed(1)}–{(s.end_ms / 1000).toFixed(1)}s
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <div className="aip-error" role="alert">{error}</div>}
          {saved && (
            <div className="aip-ok" role="status">
              {saved}
              <a className="btn sm" href={`#/workbench/${stationId}`}>前往分解工作台</a>
            </div>
          )}
        </section>

        {/* ── 右：候选确认 ── */}
        <aside className="aip-side">
          <div className="aip-side-head">
            <span>候选分段</span>
            <span className="ais-count">
              {analyzed ? `纳入 ${included.length} / 共 ${rows.length} 条 · ${totalDur}s` : '尚未分析'}
            </span>
            <button type="button" className="btn sm" disabled={!analyzed || rows.length === 0}
              title="导出候选清单 JSON，配合评测脚本与人工标注真值对比（边界误差/类型准确率）"
              onClick={exportCandidates}>
              导出候选JSON
            </button>
          </div>

          <div className="ais-table-scroll">
            {!analyzed ? (
              <div className="ais-empty">
                {analyzing ? '分析中…' : (
                  <>
                    载入视频后点「开始分析」。AI 只给候选分段，需你逐条确认后才写入要素。
                    <br />
                    <span className="ais-empty-hint">{DETECTOR_HINT[detector]}</span>
                  </>
                )}
              </div>
            ) : rows.length === 0 ? (
              <div className="ais-empty">
                未检出动作分段。常见原因：画面里没有清晰的手、镜头过远、或运动过于连续。
                <br />可重试，或改用手工分解。
              </div>
            ) : (
              <table className="ais-table">
                <thead>
                  <tr>
                    <th>
                      <input type="checkbox" aria-label="全选"
                        checked={included.length > 0 && included.length === rows.length}
                        onChange={(e) => setRows((prev) => prev.map((r) => ({ ...r, include: e.target.checked })))} />
                    </th>
                    <th>段</th><th>手别</th><th>时间段</th><th>时长</th><th>置信</th><th>提示</th><th>类型</th><th>描述</th><th>帧</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].sort((a, b) => a.start_ms - b.start_ms).map((r) => (
                    <tr key={r.id} className={`${r.include ? '' : 'dim'}${r.overlaps ? ' ov' : ''}`}
                      onClick={(e) => { if ((e.target as HTMLElement).tagName === 'TD') seekTo(r.start_ms); }}>
                      <td>
                        <input type="checkbox" checked={r.include} aria-label={`纳入 ${r.id}`}
                          onChange={(e) => patch(r.id, { include: e.target.checked })} />
                      </td>
                      <td className="mono">{r.id.toUpperCase()}</td>
                      <td>
                        {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
                        <SelectMenu ariaLabel={`${r.id} 手别`}
                          value={r.hand}
                          onChange={(v) => patch(r.id, { hand: v as Hand })}
                          options={[
                            { value: 'L', label: '左手' },
                            { value: 'R', label: '右手' },
                            { value: 'B', label: '双手' },
                          ]} />
                      </td>
                      <td className="mono">{(r.start_ms / 1000).toFixed(1)}–{(r.end_ms / 1000).toFixed(1)}s</td>
                      <td className="mono">{durOf(r)}s</td>
                      <td className={r.tier === 'low' ? 'ais-conf-weak' : ''}>
                        {r.conf.toFixed(2)} · {r.tier === 'high' ? '高' : r.tier === 'mid' ? '中' : '低'}
                        {r.reason ? `（${r.reason}）` : ''}
                      </td>
                      <td className="ais-waste-cell">
                        {r.waste && r.waste.length
                          ? r.waste.map((w) => <div className="ais-waste" key={w} title="规则直判提示：AI 只标记，采纳/忽略由你终裁">{w}</div>)
                          : null}
                        {r.sop && <div className={`ais-sop sop-${alignRes?.byCand.get(r.id)?.kind ?? 'match'}`} title="SOP 序列对齐结果：只提示不定罪">{r.sop}</div>}
                        {!r.waste?.length && !r.sop && <span className="muted">—</span>}
                      </td>
                      <td>
                        <input className="aip-inp" value={r.type} onChange={(e) => patch(r.id, { type: e.target.value })}
                          list="aip-types" aria-label={`${r.id} 类型`} />
                      </td>
                      <td>
                        <input className="aip-inp wide" value={r.desc} onChange={(e) => patchDesc(r.id, e.target.value)}
                          placeholder="必填：这条动作在做什么" aria-label={`${r.id} 描述`} />
                      </td>
                      <td>
                        <button type="button" className="btn sm" aria-label={`${r.id} 证据帧`}
                          title="抓取该段的起始/中间/结束三帧作为视觉证据（本机内存展示，不上传）"
                          onClick={(ev) => { ev.stopPropagation(); void showEvidence(r); }}
                          disabled={evi !== null && evi.id === r.id && evi.urls === null}>
                          {evi !== null && evi.id === r.id && evi.urls === null ? '抓帧中…' : '帧'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <datalist id="aip-types">
            {Object.keys(TYPE_DEFAULTS).map((t) => <option key={t} value={t} />)}
          </datalist>
          {/* v3.44 P2-2 封闭词表：动词只能来自动作标准库（一级/二级全集），SOP 对齐只认这套词 */}
          <datalist id="aip-sop-verbs">
            {Object.keys(FORMAT_TPL).map((v) => <option key={v} value={v} />)}
          </datalist>

          <div className="aip-foot">
            <div className="aip-foot-row">
              <label className="aip-opt" title="有效循环数（后端要求 ≥15 才可提交）">
                循环数
                <input className="aip-num" type="number" min={15} max={60} value={cycles}
                  onChange={(e) => setCycles(Math.max(15, Number(e.target.value) || 15))} />
              </label>
              <span className="aip-opt muted" style={{ fontSize: 12 }}>
                v3.41：AI 写入一律生成<b>新版本</b>，不覆盖/混合手工分解数据
                {!canRetest && existing.length > 0 && <em className="warn">（缺少「复测」权限，无法写入）</em>}
              </span>
            </div>
            <p className="aip-note">
              写入将封存当前版本（v{station?.version}，现有 {existing.length} 条手工要素保持只读）并开新版本 v{(station?.version ?? 1) + (existing.length > 0 ? 1 : 0)} 放入 AI 要素。写入后可在分解工作台切换版本对照精修。AI 不替代 IE 判断。
            </p>
            {!confirming ? (
              <button className="btn primary" disabled={included.length === 0 || (existing.length > 0 && !canRetest)}
                onClick={() => setConfirming(true)}>
                写入新版本（{included.length} 条）
              </button>
            ) : (
              <div className="aip-confirm" role="alertdialog" aria-label="写入确认">
                <p>
                  将封存 <b>{stationId}</b> 当前版本 <b>v{station?.version}</b>（{existing.length} 条手工要素只读保留），开新版本 <b>v{(station?.version ?? 1) + (existing.length > 0 ? 1 : 0)}</b> 写入 <b>{included.length}</b> 条 AI 要素，总时长 {totalDur}s。
                </p>
                <p className="warn">手工数据与 AI 数据分版本隔离，互不覆盖；写入后可在分解工作台「版本」菜单切换查看。</p>
                <div className="aip-confirm-acts">
                  <button className="btn sm" onClick={() => setConfirming(false)} disabled={saving}>取消</button>
                  <button className="btn sm primary" onClick={() => void doWrite()} disabled={saving}>
                    {saving ? '写入中…' : '确认写入'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* v3.43 证据帧弹窗：起始/中间/结束三帧（内存展示，不上传不落库） */}
      {evi && (
        <div className="aip-evi-mask" onClick={() => setEvi(null)}>
          <div className="aip-evi" role="dialog" aria-label={`${evi.id} 证据帧`} onClick={(e) => e.stopPropagation()}>
            <div className="aip-evi-head">
              <b>{evi.id.toUpperCase()} 证据帧</b>
              <button type="button" className="btn sm" onClick={() => setEvi(null)}>关闭</button>
            </div>
            {evi.err ? (
              <p className="aip-evi-err">抓帧失败：{evi.err}</p>
            ) : !evi.urls ? (
              <p className="aip-evi-loading">正在抓取三帧证据…</p>
            ) : (
              <div className="aip-evi-grid">
                {['起始', '中间', '结束'].map((lbl, i) => (
                  <figure key={lbl}>
                    <img src={evi.urls![i]} alt={`${evi.id} ${lbl}帧`} />
                    <figcaption className="muted mono">{lbl} {(evi.times[i] / 1000).toFixed(2)}s</figcaption>
                  </figure>
                ))}
              </div>
            )}
            <p className="muted aip-evi-note">证据帧只在本次会话内存中展示，不上传、不落库。用途：核对边界与类型，辅助填写「对象/位置」。</p>
          </div>
        </div>
      )}

      {/* v3.44 P2-2 SOP 对齐面板：步骤序列（封闭词表）+ LCS 对齐 + 自动命名 */}
      {sopPanel && (
        <div className="aip-evi-mask" onClick={() => setSopPanel(false)}>
          <div className="aip-sop" role="dialog" aria-label="SOP 对齐" onClick={(e) => e.stopPropagation()}>
            <div className="aip-evi-head">
              <b>SOP 对齐（封闭词表自动命名）</b>
              <button type="button" className="btn sm" onClick={() => setSopPanel(false)}>关闭</button>
            </div>
            <p className="muted aip-sop-intro">
              按作业顺序录入该工位的<b>标准步骤</b>（动词从动作标准库词表中选——SOP 是「封闭词表」，
              AI 命名空间被它封闭，幻觉无处容身）。分析完成后点「对齐」：候选序列按 LCS 与 SOP 配对，
              命中步骤自动命名；<b>漏步/重复/顺序异常只提示，不定罪</b>。
            </p>

            <div className="aip-sop-steps">
              {sopDraft.length === 0 && <p className="muted">还没有步骤。点「＋添加步骤」按作业顺序逐条录入。</p>}
              {sopDraft.map((s, i) => (
                <div className="aip-sop-step" key={i}>
                  <span className="mono aip-sop-idx">{i + 1}</span>
                  <input className="aip-inp" value={s.verb} list="aip-sop-verbs" maxLength={32}
                    placeholder="动词（词表内选择）" aria-label={`步骤${i + 1}动词`}
                    onChange={(e) => setSopDraft((prev) => prev.map((x, k) => (k === i ? { ...x, verb: e.target.value } : x)))} />
                  <input className="aip-inp wide" value={s.object ?? ''} maxLength={64}
                    placeholder="期望对象（选填，如：后横梁）" aria-label={`步骤${i + 1}对象`}
                    onChange={(e) => setSopDraft((prev) => prev.map((x, k) => (k === i ? { ...x, object: e.target.value } : x)))} />
                  <button type="button" className="btn sm" title="上移" disabled={i === 0}
                    onClick={() => setSopDraft((prev) => { const n = [...prev]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })}>↑</button>
                  <button type="button" className="btn sm" title="下移" disabled={i === sopDraft.length - 1}
                    onClick={() => setSopDraft((prev) => { const n = [...prev]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })}>↓</button>
                  <button type="button" className="btn sm" title="删除该步"
                    onClick={() => setSopDraft((prev) => prev.filter((_, k) => k !== i))}>✕</button>
                </div>
              ))}
              <button type="button" className="btn sm" disabled={sopDraft.length >= 40}
                onClick={() => setSopDraft((prev) => [...prev, { verb: '' }])}>＋添加步骤</button>
            </div>

            <div className="aip-roi-acts" style={{ marginTop: 10 }}>
              <button type="button" className="btn sm primary" disabled={sopBusy}
                onClick={() => void saveSop()} title="保存到工位（动词按动作标准库词表在服务端校验）">
                保存到工位
              </button>
              <button type="button" className="btn sm primary" disabled={!analyzed || rows.length === 0 || !sopDraft.some((s) => s.verb.trim())}
                onClick={runAlign} title="把候选序列与 SOP 步骤做 LCS 对齐，命中步骤自动命名（不覆盖你手改的描述）">
                对齐候选
              </button>
              {sopDraft.length > 0 && (
                <button type="button" className="btn sm" disabled={sopBusy}
                  onClick={() => { setSopDraft([]); setAlignRes(null); }} title="清空步骤草稿（保存后才影响工位）">
                  清空
                </button>
              )}
            </div>

            {sopMsg && <p className="aip-roi-msg">{sopMsg}</p>}
            {alignRes && (
              <div className="aip-sop-res" role="status">
                <b>{alignRes.summary}</b>
                <ul>
                  {alignRes.items.map((it, i) => (
                    <li key={i} className={`sop-${it.kind}`}>
                      {it.kind === 'miss' && it.stepIdx != null
                        ? it.label
                        : `${it.candId?.toUpperCase() ?? ''} ${it.label}`}
                    </li>
                  ))}
                </ul>
                <p className="muted">对齐只改「机器生成态」的描述；你手改过的描述保持原样。漏步/重复请回看视频确认。</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
