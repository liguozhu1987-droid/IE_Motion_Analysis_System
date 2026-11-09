import { useCallback, useEffect, useState } from 'react';
import {
  api, ApiError, ROLE_OPTIONS,
  type AiConfigVo, type AiCustomDictVo, type AiLlmConfigVo, type AiLlmE2eVo, type AiLlmTestVo, type AiQuotaVo, type AdminUserVo, type LlmProfileVo,
} from '../api';
import { useAuth } from '../auth';
import SelectMenu from '../components/SelectMenu';
import { IconCheck, IconCross } from '../components/Icons';

const VA_CLASSES = ['VA', 'RNVA', 'NVA'];
const METHOD_HINTS = ['E', 'C', 'R', 'S'];
const ACTION_CLASSES = ['取消', '合并', '压缩', '重排', '自动化', '简化'];
/** 撞内置 8 名拒绝（规格书 §4：除非 alias_of）——与后端 WASTE_TYPES 白名单对齐 */
const BUILTIN_WASTE_TYPES = ['动作浪费', '等待浪费', '搬运浪费', '库存浪费', '不良浪费', '过剩浪费', '流程浪费', '持住浪费'];

const DICT_TYPE_LABEL: Record<string, string> = { waste_type: '浪费类型', measure_type: '措施类型' };
/** 配额三态语义标注 */
function quotaLabel(q: number): string {
  if (q === 0) return '0 = 禁用';
  if (q === -1) return '-1 = 无限';
  return `${q} 次/日`;
}

const CODE_RE = /^[a-z][a-z0-9_]{2,31}$/;

/**
 * AI 配置页（#/ai-config · 系统管理下拉入口）：
 *  - AI 服务状态只读区（GET /ai-suggestions/config：enabled/model/prompt_version/月度 token 用量）
 *  - 配额管理（GET/PUT /users/:id/ai-quota，需 user:write；0/−1/N 三态语义）
 *  - 自定义浪费/措施类型管理（GET/POST/DELETE /ai-custom-dict，需 ai:governance）
 * 后端未就绪时页面以 503/404 横幅提示「AI 服务未上线」，UI 结构先行。
 */
export default function AiConfigPage() {
  const { can, user } = useAuth();
  const canGovern = can('ai:governance');
  const canUserWrite = can('user:write');
  const canUserRead = can('user:read');

  const [tab, setTab] = useState<'status' | 'quota' | 'dict'>('status');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* ---------- AI 服务状态 ---------- */
  const [config, setConfig] = useState<AiConfigVo | null>(null);
  const [configUnavailable, setConfigUnavailable] = useState(false);

  const loadConfig = useCallback(async () => {
    try {
      const res = await api.ai.config();
      setConfig(res);
      setConfigUnavailable(false);
    } catch {
      /* 后端未就绪（404/503）：保留 UI，提示未上线 */
      setConfig(null);
      setConfigUnavailable(true);
    }
  }, []);

  useEffect(() => { void loadConfig(); }, [loadConfig]);

  /* ---------- LLM 网关配置（v3.31：管理员界面开启服务/配端点/密钥） ---------- */
  const [llmCfg, setLlmCfg] = useState<AiLlmConfigVo | null>(null);
  const [llmForm, setLlmForm] = useState({ enabled: false, base_url: '', model: '', api_key: '' });
  const [llmSaving, setLlmSaving] = useState(false);

  const loadLlm = useCallback(async () => {
    try {
      const res = await api.ai.llmConfig.get();
      setLlmCfg(res);
      setLlmForm({ enabled: res.enabled, base_url: res.base_url, model: res.model, api_key: '' });
    } catch {
      setLlmCfg(null);
    }
  }, []);

  useEffect(() => {
    if (canUserWrite || canGovern) void loadLlm();
  }, [canUserWrite, canGovern, loadLlm]);

  const saveLlm = async () => {
    setLlmSaving(true); setError(null); setMsg(null);
    try {
      const payload: Parameters<typeof api.ai.llmConfig.put>[0] = {
        enabled: llmForm.enabled,
        base_url: llmForm.base_url.trim(),
        model: llmForm.model.trim(),
      };
      // api_key 留空 = 不修改（仅输入了新值才覆盖）
      if (llmForm.api_key.trim()) payload.api_key = llmForm.api_key.trim();
      const res = await api.ai.llmConfig.put(payload);
      setLlmCfg(res);
      setLlmForm({ enabled: res.enabled, base_url: res.base_url, model: res.model, api_key: '' });
      setMsg(`LLM 网关配置已保存${res.enabled ? '，AI 服务已开启' : '，AI 服务已停用'}。`);
      await loadConfig();
    } catch (err) {
      if (err instanceof ApiError && err.hint) setError(`${err.message}（${err.hint}）`);
      else setError((err as Error).message);
    } finally {
      setLlmSaving(false);
    }
  };

  /* 连接测试（v3.32）：表单值 dry-run——不保存也能测；零 token 探活 + 1 token 验证 */
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTest, setLlmTest] = useState<AiLlmTestVo | null>(null);

  const testLlm = async () => {
    setLlmTesting(true); setError(null); setMsg(null); setLlmTest(null);
    try {
      const payload: Parameters<typeof api.ai.llmConfig.test>[0] = {
        base_url: llmForm.base_url.trim(),
        model: llmForm.model.trim(),
      };
      if (llmForm.api_key.trim()) payload.api_key = llmForm.api_key.trim();
      setLlmTest(await api.ai.llmConfig.test(payload));
    } catch (err) {
      if (err instanceof ApiError && err.hint) setError(`${err.message}（${err.hint}）`);
      else setError((err as Error).message);
    } finally {
      setLlmTesting(false);
    }
  };

  /* AI 功能端到端自测（v3.35）：真实 LLM→解析→三轮校验→计算；样例工位不落库不扣配额 */
  const [e2eTesting, setE2eTesting] = useState(false);
  const [e2eResult, setE2eResult] = useState<AiLlmE2eVo | null>(null);

  const runE2e = async () => {
    setE2eTesting(true); setError(null); setMsg(null); setE2eResult(null); setLlmTest(null);
    try {
      const payload: Parameters<typeof api.ai.llmConfig.e2eTest>[0] = {
        base_url: llmForm.base_url.trim(),
        model: llmForm.model.trim(),
      };
      if (llmForm.api_key.trim()) payload.api_key = llmForm.api_key.trim();
      setE2eResult(await api.ai.llmConfig.e2eTest(payload));
    } catch (err) {
      if (err instanceof ApiError && err.hint) setError(`${err.message}（${err.hint}）`);
      else setError((err as Error).message);
    } finally {
      setE2eTesting(false);
    }
  };

  /* ---------- 连接配置 profiles（v3.40：多配置单活，「启用」即切换生效连接） ---------- */
  const [profiles, setProfiles] = useState<LlmProfileVo[] | null>(null);
  const [profileForm, setProfileForm] = useState<{ open: boolean; id: string | null; name: string; base_url: string; api_key: string; model: string }>({
    open: false, id: null, name: '', base_url: '', api_key: '', model: '',
  });
  const [profileBusy, setProfileBusy] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    if (!canUserWrite) return;
    try {
      setProfiles(await api.ai.llmProfiles.list());
    } catch {
      setProfiles(null);
    }
  }, [canUserWrite]);

  useEffect(() => { void loadProfiles(); }, [loadProfiles]);

  const reloadAfterProfile = async (m: string) => {
    setMsg(m);
    await Promise.all([loadProfiles(), loadLlm(), loadConfig()]);
  };

  const saveProfile = async () => {
    const f = profileForm;
    if (!f.name.trim() || !f.base_url.trim() || !f.model.trim()) {
      setError('配置名称、Base URL、模型名均为必填');
      return;
    }
    setProfileBusy('save'); setError(null); setMsg(null);
    try {
      if (f.id) {
        // 编辑：api_key 留空 = 保持原 Key
        const payload: Parameters<typeof api.ai.llmProfiles.update>[1] = { name: f.name.trim(), base_url: f.base_url.trim(), model: f.model.trim() };
        if (f.api_key.trim()) payload.api_key = f.api_key.trim();
        await api.ai.llmProfiles.update(f.id, payload);
        await reloadAfterProfile(`连接配置「${f.name.trim()}」已保存。`);
      } else {
        await api.ai.llmProfiles.create({ name: f.name.trim(), base_url: f.base_url.trim(), model: f.model.trim(), ...(f.api_key.trim() ? { api_key: f.api_key.trim() } : {}) });
        await reloadAfterProfile(`连接配置「${f.name.trim()}」已新增${f.api_key.trim() ? '' : '（未设 Key，回落 .env）'}。`);
      }
      setProfileForm({ open: false, id: null, name: '', base_url: '', api_key: '', model: '' });
    } catch (err) {
      if (err instanceof ApiError && err.hint) setError(`${err.message}（${err.hint}）`);
      else setError((err as Error).message);
    } finally {
      setProfileBusy(null);
    }
  };

  const activateProfile = async (p: LlmProfileVo) => {
    setProfileBusy(p.profile_id); setError(null); setMsg(null);
    try {
      await api.ai.llmProfiles.activate(p.profile_id);
      await reloadAfterProfile(`已启用连接配置「${p.name}」——当前生效 API 已切换。`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProfileBusy(null);
    }
  };

  const removeProfile = async (p: LlmProfileVo) => {
    if (!window.confirm(`确认删除连接配置「${p.name}」？此操作不可恢复。`)) return;
    setProfileBusy(p.profile_id); setError(null); setMsg(null);
    try {
      await api.ai.llmProfiles.remove(p.profile_id);
      await reloadAfterProfile(`连接配置「${p.name}」已删除。`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProfileBusy(null);
    }
  };

  const testProfile = async (p: LlmProfileVo) => {
    setProfileBusy(p.profile_id); setError(null); setMsg(null); setLlmTest(null);
    try {
      setLlmTest(await api.ai.llmConfig.test({ profile_id: p.profile_id }));
    } catch (err) {
      if (err instanceof ApiError && err.hint) setError(`${err.message}（${err.hint}）`);
      else setError((err as Error).message);
    } finally {
      setProfileBusy(null);
    }
  };

  /* ---------- 配额管理 ---------- */
  const [users, setUsers] = useState<AdminUserVo[]>([]);
  const [quotas, setQuotas] = useState<Record<string, number>>({});
  const [quotaSaving, setQuotaSaving] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    if (!canUserRead) return;
    try {
      const res = await api.adminUsers();
      setUsers(res.users);
      // 逐个拉配额（契约：GET /users/:id/ai-quota 无列表端点）
      const entries = await Promise.all(res.users.map(async (u) => {
        try {
          const q = await api.ai.quota.get(u.userId);
          return [u.userId, q.ai_quota] as const;
        } catch { return [u.userId, 1] as const; }
      }));
      setQuotas(Object.fromEntries(entries));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [canUserRead]);

  useEffect(() => {
    if (canUserWrite) void loadUsers();
  }, [canUserWrite, loadUsers]);

  const saveQuota = async (u: AdminUserVo, value: number) => {
    if (!Number.isInteger(value) || value === 0 || value < -1) {
      setError('配额须为 0（禁用）、-1（无限）或正整数次数');
      return;
    }
    setQuotaSaving(u.userId); setError(null); setMsg(null);
    try {
      const res = await api.ai.quota.put(u.userId, value);
      setQuotas((prev) => ({ ...prev, [u.userId]: res.ai_quota }));
      setMsg(`已保存 ${u.displayName || u.username} 的 AI 配额：${quotaLabel(res.ai_quota)}`);
    } catch (err) {
      if (err instanceof ApiError && err.hint) setError(`${err.message}（${err.hint}）`);
      else setError((err as Error).message);
    } finally {
      setQuotaSaving(null);
    }
  };

  /* ---------- 自定义字典 ---------- */
  const [dictType, setDictType] = useState<'waste_type' | 'measure_type'>('waste_type');
  const [dictRows, setDictRows] = useState<AiCustomDictVo[]>([]);
  const [dictUnavailable, setDictUnavailable] = useState(false);
  const [form, setForm] = useState({
    code: '', name: '', va_class: 'RNVA', method_hint: 'S', action_class: '简化', alias_of: '',
  });
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const loadDict = useCallback(async () => {
    try {
      const res = await api.ai.dict.list();
      setDictRows(res?.items ?? []);
      setDictUnavailable(false);
    } catch {
      setDictRows([]);
      setDictUnavailable(true);
    }
  }, []);

  useEffect(() => {
    if (canGovern) void loadDict();
  }, [canGovern, loadDict]);

  const validateForm = (): boolean => {
    const errs: Record<string, string> = {};
    if (!CODE_RE.test(form.code)) errs.code = '编码须小写字母开头，3~32 位小写字母/数字/下划线';
    if (!form.name.trim()) errs.name = '名称必填';
    else if (form.name.trim().length > 16) errs.name = '名称不超过 16 字';
    else if (dictType === 'waste_type' && BUILTIN_WASTE_TYPES.includes(form.name.trim()) && !form.alias_of.trim()) {
      errs.name = '与内置浪费类型撞名（如需引用请填写「别名于」）';
    }
    if (dictType === 'waste_type' && !form.va_class) errs.va_class = '浪费类型必填 VA 类别（未声明按 RNVA 保守处理）';
    if (dictType === 'measure_type' && !form.method_hint) errs.method_hint = '措施类型必填手法提示（E/C/R/S）';
    if (dictType === 'measure_type' && !form.action_class) errs.action_class = '措施类型必填动作类别';
    setFormErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const createDict = async () => {
    if (!validateForm()) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const payload: Parameters<typeof api.ai.dict.create>[0] = {
        dict_type: dictType,
        code: form.code.trim(),
        name: form.name.trim(),
      };
      if (dictType === 'waste_type') payload.va_class = form.va_class;
      else { payload.method_hint = form.method_hint; payload.action_class = form.action_class; }
      if (form.alias_of.trim()) payload.alias_of = form.alias_of.trim();
      const res = await api.ai.dict.create(payload);
      setMsg(`已创建自定义${DICT_TYPE_LABEL[dictType]}：${res.name}（${res.code}）`);
      setForm({ code: '', name: '', va_class: 'RNVA', method_hint: 'S', action_class: '简化', alias_of: '' });
      await loadDict();
    } catch (err) {
      if (err instanceof ApiError && err.hint) setError(`${err.message}（${err.hint}）`);
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteDict = async (row: AiCustomDictVo) => {
    if (!window.confirm(`删除自定义${DICT_TYPE_LABEL[row.dict_type]}「${row.name}（${row.code}）」？\n已生成过的建议不受影响（仅影响后续生成的白名单校验）。`)) return;
    setBusy(true); setError(null);
    try {
      await api.ai.dict.remove(row.dict_id);
      setMsg(`已删除：${row.name}`);
      await loadDict();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tabs = [
    { key: 'status' as const, label: 'AI 服务状态', hint: '模型 / 提示词版本 / 用量', show: true },
    { key: 'quota' as const, label: 'AI 配额管理', hint: '各用户每日生成次数', show: canUserWrite },
    { key: 'dict' as const, label: '自定义类型', hint: '浪费 / 措施类型扩展', show: canGovern },
  ].filter((t) => t.show);

  /* 无任何 AI 治理权限且 user:read 都没有时——只读状态区对所有人开放（契约：ai:governance 或 user:read） */

  return (
    <div>
      <div className="page-head">
        <h1>AI 配置</h1>
        <span className="sub">AI 改善建议的服务状态、用户配额与自定义类型治理</span>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      <div className="set-tabs no-print">
        {tabs.map((t) => (
          <button key={t.key} className={`set-tab${tab === t.key ? ' on' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}<small>{t.hint}</small>
          </button>
        ))}
      </div>

      {/* ---------- AI 服务状态（只读） ---------- */}
      {tab === 'status' && (
        <div className="card">
          <h3>AI 服务状态</h3>
          {configUnavailable && (
            <div className="banner-warn" style={{ borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
              AI 建议服务未上线或未开启（AI_SUGGEST_ENABLED=false）——以下信息暂不可读。
            </div>
          )}
          {config ? (
            <dl className="cfg-list">
              <div className="cfg-row"><dt>服务开关</dt>
                <dd>{config.enabled ? <span className="tag t-teal">已启用</span> : <span className="tag t-gray">未启用</span>}
                  {config.llm_circuit_open && <span className="tag t-red" style={{ marginLeft: 6 }} title="LLM 网关熔断中：生成请求将被拒绝，稍后自动恢复">LLM 熔断中</span>}</dd></div>
              <div className="cfg-row"><dt>模型</dt><dd className="mono">{config.model ?? '—'}</dd></div>
              <div className="cfg-row"><dt>提示词版本</dt><dd className="mono">{config.prompt_version ?? '—'}</dd></div>
              <div className="cfg-row"><dt>月度 token 用量</dt>
                <dd className="mono">{config.monthly_tokens_used.toLocaleString()}{config.monthly_token_limit != null ? ` / ${config.monthly_token_limit.toLocaleString()}（上限）` : '（未设上限）'}</dd></div>
              <div className="cfg-row"><dt>当日配额（当前用户）</dt>
                <dd>{config.quota_unlimited ? '无限（user:write 豁免或 quota=-1）' : `${config.quota_used} / ${config.quota === -1 ? '无限' : config.quota}`}</dd></div>
              <div className="cfg-row"><dt>配额维度</dt><dd className="mono">{config.quota_scope === 'station' ? '工位维度（station）' : config.quota_scope}</dd></div>
              <div className="cfg-row"><dt>批次节省上限</dt><dd>工位 CT 的 {(config.batch_ceiling * 100).toFixed(0)}%（超出转人工复核，不剔除）</dd></div>
            </dl>
          ) : (
            <div className="muted">
              {configUnavailable ? '等待后端 AI 模块上线后自动展示。' : '加载中…'}
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
            AI 建议永远处于「待审」状态：采纳后才会进入改善任务（status=待实施）；数字（节省秒数/优先级）全部服务端计算，LLM 输出中的数字一律剥除。
          </p>
        </div>
      )}

      {/* ---------- 连接配置 profiles（v3.40：多配置单活） ---------- */}
      {tab === 'status' && canUserWrite && (
        <div className="card" style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h3 style={{ margin: 0 }}>连接配置</h3>
            <span className="muted" style={{ fontSize: 12 }}>多条 API 连接二选一启用：点「启用」即切换正式生效的连接，同一时刻仅一条生效</span>
            <span className="spacer" style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => setProfileForm({ open: true, id: null, name: '', base_url: '', api_key: '', model: '' })}>
              ＋ 新增配置
            </button>
          </div>
          {profileForm.open && (
            <div style={{ margin: '10px 0', padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8 }}>
              <div className="llm-form" style={{ gridTemplateColumns: 'minmax(140px,0.9fr) minmax(240px,1.5fr) minmax(150px,1fr) minmax(150px,1fr)' }}>
                <label className="filter-item">
                  <span>配置名称</span>
                  <input value={profileForm.name} placeholder="如：火山方舟 / 内网 vLLM"
                    onChange={(e) => setProfileForm((f) => ({ ...f, name: e.target.value }))} />
                </label>
                <label className="filter-item">
                  <span>Base URL（OpenAI 兼容）</span>
                  <input className="mono" value={profileForm.base_url} placeholder="https://host/v1"
                    onChange={(e) => setProfileForm((f) => ({ ...f, base_url: e.target.value }))} />
                </label>
                <label className="filter-item">
                  <span>API Key{profileForm.id ? '（留空＝保持原 Key）' : ''}</span>
                  <input className="mono" type="password" value={profileForm.api_key} placeholder="sk-…"
                    onChange={(e) => setProfileForm((f) => ({ ...f, api_key: e.target.value }))} />
                </label>
                <label className="filter-item">
                  <span>模型名</span>
                  <input className="mono" value={profileForm.model} placeholder="deepseek-v4-pro"
                    onChange={(e) => setProfileForm((f) => ({ ...f, model: e.target.value }))} />
                </label>
              </div>
              <div className="llm-actions" style={{ borderTop: 'none', paddingTop: 0 }}>
                <span className="muted" style={{ fontSize: 12 }}>新增的第一条配置会自动启用；编辑不影响启用状态。</span>
                <span className="spacer" />
                <button className="btn sm" onClick={() => setProfileForm({ open: false, id: null, name: '', base_url: '', api_key: '', model: '' })}>取消</button>
                <button className="btn primary sm" disabled={profileBusy === 'save'} onClick={() => void saveProfile()}>
                  {profileBusy === 'save' ? '保存中…' : profileForm.id ? '保存修改' : '创建'}
                </button>
              </div>
            </div>
          )}
          {profiles === null ? (
            <div className="muted" style={{ marginTop: 8 }}>连接配置加载中或服务未上线…</div>
          ) : profiles.length === 0 ? (
            <div className="muted" style={{ marginTop: 8 }}>暂无连接配置——点右上「＋ 新增配置」创建第一条连接。</div>
          ) : (
            <div className="llm-profiles">
              {profiles.map((p) => (
                <div key={p.profile_id} className={`llm-profile-row${p.enabled === 1 ? ' on' : ''}`}>
                  <span className={`tag ${p.enabled === 1 ? 't-teal' : 't-gray'}`}>{p.enabled === 1 ? '启用中' : '未启用'}</span>
                  <b style={{ minWidth: 90, overflowWrap: 'anywhere' }}>{p.name}</b>
                  <span className="mono muted" style={{ flex: 1, minWidth: 160, overflowWrap: 'anywhere' }}>{p.base_url}</span>
                  <span className="mono" style={{ minWidth: 110, overflowWrap: 'anywhere' }}>{p.model}</span>
                  <span className="mono muted" style={{ minWidth: 100 }}>{p.api_key_masked || '未设 Key'}</span>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {p.enabled !== 1 && (
                      <button className="btn primary sm" disabled={profileBusy === p.profile_id} onClick={() => void activateProfile(p)} title="切换为当前正式生效的 API 连接">
                        {profileBusy === p.profile_id ? '切换中…' : '启用'}
                      </button>
                    )}
                    <button className="btn sm" disabled={profileBusy === p.profile_id} onClick={() => void testProfile(p)} title="用该配置存储值做连接测试（不落库不改变启用状态）">
                      测试
                    </button>
                    <button className="btn sm" onClick={() => setProfileForm({ open: true, id: p.profile_id, name: p.name, base_url: p.base_url, api_key: '', model: p.model })}>
                      编辑
                    </button>
                    {p.enabled !== 1 && (
                      <button className="btn sm" disabled={profileBusy === p.profile_id} onClick={() => void removeProfile(p)}>
                        删除
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>
            启用中的配置决定「AI 改善建议 / 浪费识别」实际调用的网关；下方「LLM 网关配置」编辑的也是当前启用中的这条配置。
          </p>
        </div>
      )}

      {/* ---------- LLM 网关配置（v3.31：服务开关 + 端点/模型/密钥，管理员可写） ---------- */}
      {tab === 'status' && canUserWrite && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>LLM 网关配置</h3>
          <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>
            此处配置<b>优先于服务端 .env</b>。开启服务后「AI 改善建议」按钮即可用；API Key 保存后只显示脱敏值，留空表示不修改。
          </p>
          {llmCfg && (
            <div className="src-badges">
              {llmCfg.active_profile && <span className="src-badge src-db">生效配置 <b>{llmCfg.active_profile.name}</b></span>}
              <span className="src-badge">配置来源</span>
              <span className={`src-badge${llmCfg.enabled_source === 'db' ? ' src-db' : ''}`}>开关 <b>{llmCfg.enabled_source === 'db' ? '本页' : '.env'}</b></span>
              <span className={`src-badge${llmCfg.base_url_source === 'db' ? ' src-db' : ''}`}>Base URL <b>{llmCfg.base_url_source === 'db' ? '本页' : '.env'}</b></span>
              <span className={`src-badge${llmCfg.api_key_source === 'db' ? ' src-db' : ''}`}>API Key <b>{llmCfg.api_key_source === 'db' ? `本页（${llmCfg.api_key_masked || '未设'}）` : `.env（${llmCfg.api_key_masked || '未设'}）`}</b></span>
              <span className={`src-badge${llmCfg.model_source === 'db' ? ' src-db' : ''}`}>模型 <b>{llmCfg.model_source === 'db' ? '本页' : '.env'}</b></span>
            </div>
          )}
          <div className="llm-form">
            <label className="filter-item">
              <span>Base URL（OpenAI 兼容 /chat/completions）</span>
              <input className="mono" value={llmForm.base_url} placeholder="https://api.openai.com/v1"
                onChange={(e) => setLlmForm((f) => ({ ...f, base_url: e.target.value }))} />
            </label>
            <label className="filter-item">
              <span>模型名</span>
              <input className="mono" value={llmForm.model} placeholder="qwen2.5-14b / gpt-4o-mini"
                onChange={(e) => setLlmForm((f) => ({ ...f, model: e.target.value }))} />
            </label>
            <label className="filter-item">
              <span>API Key（留空不修改）</span>
              <input className="mono" type="password" value={llmForm.api_key}
                placeholder={llmCfg?.api_key_masked ? `已设：${llmCfg.api_key_masked}` : 'sk-…'}
                onChange={(e) => setLlmForm((f) => ({ ...f, api_key: e.target.value }))} />
            </label>
          </div>
          <div className="llm-actions">
            <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={llmForm.enabled}
                onChange={(e) => setLlmForm((f) => ({ ...f, enabled: e.target.checked }))} />
              <b>开启 AI 建议服务</b>
            </label>
            <span className="muted" style={{ fontSize: 12 }}>
              {llmForm.enabled ? '开启后：有权限的用户在工作台可生成 AI 建议' : '停用后：生成入口返回「AI 建议未启用」'}
            </span>
            <span className="spacer" />
            <button className="btn sm" disabled={llmTesting} onClick={() => void testLlm()}>
              {llmTesting ? '测试中…' : '测试连接'}
            </button>
            <button className="btn sm" disabled={e2eTesting} onClick={() => void runE2e()}
              title="用内置样例工位走真实全链：LLM 生成 → 三轮校验 → 数字计算；不落库、不扣配额">
              {e2eTesting ? '自测中…' : 'AI 功能自测'}
            </button>
            <button className="btn primary sm" disabled={llmSaving} onClick={() => void saveLlm()}>
              {llmSaving ? '保存中…' : '保存 LLM 配置'}
            </button>
          </div>

          {/* 连接测试结果（v3.32：两级探测——零 token 探活 + 1 token 验证） */}
          {llmTest && (            <div
              className={llmTest.ok ? 'banner-success' : 'banner-error'}
              style={{ borderRadius: 8, padding: '10px 12px', marginTop: 12, fontSize: 13, lineHeight: 1.7 }}
            >
              {llmTest.ok ? (
                <>
                  <b><IconCheck />连接正常</b> · 总延迟 {llmTest.latency_ms}ms · 模型 <span className="mono">{llmTest.model}</span>
                  <div className="muted" style={{ fontSize: 12 }}>
                    ① 零 token 探活（GET /models）：{llmTest.checks.models.ok
                      ? `通过（${llmTest.checks.models.latency_ms}ms${llmTest.model_listed === true ? '，模型在清单中' : ''}）`
                      : `未通过（${llmTest.checks.models.reason ?? '—'}）`}
                    {' · '}
                    ② 最小 token 验证（max_tokens=1）：通过（{llmTest.checks.chat.latency_ms}ms
                    {llmTest.tokens_used != null ? `，实测 ${llmTest.tokens_used} token` : ''}）
                  </div>
                </>
              ) : (
                <>
                  <b><IconCross />连接失败</b>：{llmTest.diagnosis}
                  <div style={{ fontSize: 12 }}>修复建议：{llmTest.suggestion}</div>
                  <div className="muted mono" style={{ fontSize: 11, marginTop: 4 }}>
                    HTTP {llmTest.checks.chat.http_status || '—'} · 零 token 探活{llmTest.checks.models.ok ? '通过' : `失败（${llmTest.checks.models.reason ?? '—'}）`}
                    {llmTest.checks.chat.sample ? ` · 响应片段：${llmTest.checks.chat.sample}` : ''}
                  </div>
                </>
              )}
              {llmTest.warnings.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  {llmTest.warnings.map((w, i) => <div key={i}>提示：{w}</div>)}
                </div>
              )}
            </div>
          )}

          {/* AI 功能端到端自测结果（v3.35：真实全链——LLM 生成→三轮校验→数字计算） */}
          {e2eResult && (
            <div
              className={e2eResult.ok ? 'banner-success' : 'banner-error'}
              style={{ borderRadius: 8, padding: '10px 12px', marginTop: 12, fontSize: 13, lineHeight: 1.7 }}
            >
              {e2eResult.ok ? (
                <>
                  <b><IconCheck />AI 功能自测通过</b> · 全链 {e2eResult.latency_ms}ms · 消耗 {e2eResult.tokens_used} token
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    LLM 原始候选 <b>{e2eResult.raw_count}</b> 条 → 三轮校验通过 <b>{e2eResult.accepted_count}</b> 条
                    {e2eResult.dropped_count > 0 && <>（剔除 {e2eResult.dropped_count} 条）</>}
                    ——生成、解析、校验、计算链路全部正常
                  </div>
                  {e2eResult.suggestions.slice(0, 3).map((s, i) => (
                    <div key={i} className="mono" style={{ fontSize: 11.5, marginTop: 6, background: 'rgba(0,0,0,.04)', borderRadius: 6, padding: '6px 8px' }}>
                      [{s.tier ?? '—'}] {s.waste_type} · {s.method} 法 · 要素 {s.element_seqs.join('/')} · 省 {s.est_save_s ?? '—'}s
                      {s.risk_flags.length > 0 && <span style={{ color: '#b45309' }}> · ⚑ {s.risk_flags.join(',')}</span>}
                      <div style={{ color: 'inherit', opacity: 0.75 }}>{s.measure.slice(0, 60)}{s.measure.length > 60 ? '…' : ''}</div>
                    </div>
                  ))}
                </>
              ) : (
                <>
                  <b><IconCross />AI 功能自测未通过</b>（阶段：
                  {e2eResult.stage === 'llm_call' && 'LLM 调用'}
                  {e2eResult.stage === 'parse' && '输出解析'}
                  {e2eResult.stage === 'validation' && '三轮校验'}）
                  <div style={{ fontSize: 12, marginTop: 4 }}>{e2eResult.error}</div>
                  <div style={{ fontSize: 12 }}>建议：{e2eResult.suggestion}</div>
                  {e2eResult.raw_head && (
                    <div className="mono" style={{ fontSize: 11, marginTop: 6, opacity: 0.8 }}>输出头部：{e2eResult.raw_head.slice(0, 160)}</div>
                  )}
                </>
              )}
            </div>
          )}

          <div className="best-practice">
            <h4>密钥配置最佳实践</h4>
            <ol>
              <li>使用<b>专用 Key</b>：仅开通 chat 权限，不复用管理员全局 Key；</li>
              <li>密钥只在<b>服务端保存</b>，界面仅回显脱敏值；生产与测试环境使用不同 Key，并定期轮换；</li>
              <li>「测试连接」与「AI 功能自测」均用当前表单值 dry-run——<b>不保存、不写配置、不计配额、不产生正式数据</b>；</li>
              <li>连接测试以「零 token 探活 + 1 token 对话」最小代价验证连通性；功能自测用内置样例工位走<b>真实生成全链</b>（生成→解析→三轮校验→数字计算），验证模型能否产出符合系统规格的建议。</li>
            </ol>
          </div>
        </div>
      )}
      {tab === 'status' && !canUserWrite && canGovern && llmCfg && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>LLM 网关配置（只读）</h3>
          <dl className="cfg-list">
            <div className="cfg-row"><dt>服务开关</dt><dd>{llmCfg.enabled ? '已开启' : '已停用'}（{llmCfg.enabled_source === 'db' ? '本页配置' : '.env'}）</dd></div>
            <div className="cfg-row"><dt>Base URL</dt><dd className="mono">{llmCfg.base_url}（{llmCfg.base_url_source === 'db' ? '本页配置' : '.env'}）</dd></div>
            <div className="cfg-row"><dt>模型</dt><dd className="mono">{llmCfg.model}（{llmCfg.model_source === 'db' ? '本页配置' : '.env'}）</dd></div>
            <div className="cfg-row"><dt>API Key</dt><dd className="mono">{llmCfg.api_key_masked || '未设置'}（{llmCfg.api_key_source === 'db' ? '本页配置' : '.env'}）</dd></div>
          </dl>
          <p className="muted" style={{ fontSize: 12, margin: '10px 0 0' }}>修改 LLM 配置需要「用户管理」写权限（user:write），请联系系统管理员。</p>
        </div>
      )}

      {/* ---------- 配额管理 ---------- */}
      {tab === 'quota' && canUserWrite && (
        <div className="card">
          <h3>AI 配额管理</h3>
          <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>
            语义：<b>0</b> = 禁用 AI 生成 · <b>-1</b> = 无限 · <b>N</b> = 每日 N 次。配额按工位维度计（同一工位重复生成命中幂等槽位不重复计费）。
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>用户</th><th>角色</th><th style={{ width: 150 }}>配额</th><th>语义</th><th style={{ width: 90 }} /></tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const q = quotas[u.userId];
                  const editable = q !== undefined;
                  return (
                    <tr key={u.userId}>
                      <td style={{ overflowWrap: 'anywhere' }}>{u.displayName || u.username}<div className="muted mono" style={{ fontSize: 11.5 }}>{u.username}</div></td>
                      <td className="muted" style={{ overflowWrap: 'anywhere' }}>{u.roles.map((r) => ROLE_OPTIONS.find((o) => o.code === r)?.name ?? r).join(' / ')}</td>
                      <td>
                        <input type="number" step={1} value={Number.isInteger(q) ? q : ''} disabled={!editable}
                          style={{ width: 90 }} title="0=禁用 · -1=无限 · N=每日次数"
                          onChange={(e) => setQuotas((prev) => ({ ...prev, [u.userId]: Number(e.target.value) }))} />
                      </td>
                      <td className="muted">{Number.isInteger(q) ? quotaLabel(q) : '…'}</td>
                      <td>
                        {editable && (
                          <button className="btn sm" disabled={quotaSaving === u.userId}
                            onClick={() => void saveQuota(u, quotas[u.userId])}>
                            {quotaSaving === u.userId ? '保存中…' : '保存'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {users.length === 0 && <tr><td colSpan={5} className="empty">用户列表为空或加载中。</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------- 自定义类型 ---------- */}
      {tab === 'dict' && canGovern && (
        <>
          <div className="card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>自定义类型（租户级字典）</h3>
              <div className="row">
                {/* v3.59.1 SelectMenu 自绘，根治原生 popup 漂移飞走 */}
                <SelectMenu ariaLabel="字典类型" triggerStyle={{ minWidth: 140 }}
                  value={dictType}
                  onChange={(v) => { setDictType(v as 'waste_type' | 'measure_type'); setFormErrors({}); }}
                  options={[
                    { value: 'waste_type', label: '浪费类型' },
                    { value: 'measure_type', label: '措施类型' },
                  ]} />
              </div>
            </div>
            {dictUnavailable && (
              <div className="banner-warn" style={{ borderRadius: 8, padding: '8px 12px', margin: '10px 0' }}>
                自定义类型服务未上线（后端 AI 模块开发中）——表单先行，保存暂不可用。
              </div>
            )}
            {/* 表单 */}
            <div className="filter-bar" style={{ margin: '10px 0' }}>
              <label className="filter-item"><span>编码 code</span>
                <input className={`mono${formErrors.code ? ' in-err' : ''}`} value={form.code} placeholder="long_reach"
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
              </label>
              <label className="filter-item"><span>名称（≤16 字）</span>
                <input className={formErrors.name ? 'in-err' : ''} value={form.name} placeholder="远距伸手"
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </label>
              {dictType === 'waste_type' && (
                <label className="filter-item"><span>VA 类别（必填）</span>
                  {/* v3.59.1 SelectMenu 自绘；错误态走 error 通道（替代 in-err） */}
                  <SelectMenu ariaLabel="VA 类别" error={!!formErrors.va_class}
                    value={form.va_class}
                    onChange={(v) => setForm((f) => ({ ...f, va_class: v }))}
                    options={VA_CLASSES.map((v) => ({ value: v, label: v }))} />
                </label>
              )}
              {dictType === 'measure_type' && (
                <>
                  <label className="filter-item"><span>手法提示（必填）</span>
                    <SelectMenu ariaLabel="手法提示" error={!!formErrors.method_hint}
                      value={form.method_hint}
                      onChange={(v) => setForm((f) => ({ ...f, method_hint: v }))}
                      options={METHOD_HINTS.map((m) => ({ value: m, label: m }))} />
                  </label>
                  <label className="filter-item"><span>动作类别（必填）</span>
                    <SelectMenu ariaLabel="动作类别" error={!!formErrors.action_class}
                      value={form.action_class}
                      onChange={(v) => setForm((f) => ({ ...f, action_class: v }))}
                      options={ACTION_CLASSES.map((a) => ({ value: a, label: a }))} />
                  </label>
                </>
              )}
              <label className="filter-item"><span>别名于（可选）</span>
                <input className="mono" value={form.alias_of} placeholder="引用内置类型编码"
                  onChange={(e) => setForm((f) => ({ ...f, alias_of: e.target.value }))} />
              </label>
              <button className="btn primary sm" disabled={busy} onClick={() => void createDict()}>+ 创建</button>
            </div>
            {Object.values(formErrors).length > 0 && (
              <div className="banner-error" style={{ borderRadius: 8, padding: '8px 12px' }}>
                {Object.values(formErrors).map((e, i) => <div key={i}>{e}</div>)}
              </div>
            )}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>类型</th><th>编码</th><th>名称</th>
                    <th>{dictType === 'waste_type' ? 'VA 类别' : '手法 / 动作'}</th>
                    <th>别名于</th><th>创建人</th><th style={{ width: 70 }} /></tr>
                </thead>
                <tbody>
                  {dictRows.filter((r) => r.dict_type === dictType).map((r) => (
                    <tr key={r.dict_id}>
                      <td>{DICT_TYPE_LABEL[r.dict_type]}</td>
                      <td className="mono">{r.code}</td>
                      <td>{r.name}</td>
                      <td className="muted">
                        {r.dict_type === 'waste_type'
                          ? (r.va_class ?? '—')
                          : `${r.method_hint ?? '—'} / ${r.action_class ?? '—'}`}
                      </td>
                      <td className="mono muted">{r.alias_of ?? '—'}</td>
                      <td>{r.created_by ?? '—'}</td>
                      <td><button className="btn sm danger" disabled={busy} onClick={() => void deleteDict(r)}>删除</button></td>
                    </tr>
                  ))}
                  {dictRows.filter((r) => r.dict_type === dictType).length === 0 && (
                    <tr><td colSpan={7} className="empty">
                      暂无自定义{DICT_TYPE_LABEL[dictType]}。创建后进入 AI 生成白名单（waste_type 白名单 = 内置 ∪ 租户自定义）。
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div className="note" style={{ marginTop: 12 }}>
            自定义浪费类型须声明 VA 类别（未声明按 RNVA 保守处理）；自定义措施类型须声明手法提示（E/C/R/S）与动作类别。
            撞内置 8 名的浪费类型会被拒绝，除非声明「别名于」该内置类型。
          </div>
        </>
      )}

      {!canGovern && !canUserWrite && tab === 'status' && user && null}
    </div>
  );
}
