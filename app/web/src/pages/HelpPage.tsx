import { useEffect, useRef, useState } from 'react';

/**
 * 系统使用帮助（#/help）。
 * 面向所有登录用户（权限放行见 App.tsx），内容只覆盖已落地功能：
 * 认证/首页/主数据/动作标准库/分解工作台/分析/对比/改善任务/AI 自动分解/AI 建议/浪费识别/设置/权限中心。
 * 不描述任何未上线的规划或单次任务报告。
 */

interface Section {
  id: string;
  title: string;
  sub?: { id: string; title: string }[];
}

const SECTIONS: Section[] = [
  { id: 'intro', title: '一、系统简介' },
  { id: 'start', title: '二、快速上手（五步）' },
  { id: 'concepts', title: '三、核心概念', sub: [
    { id: 'motion', title: '动素三分法' },
    { id: 'va-rule', title: '增值判定与改判' },
    { id: 'benefit', title: '收益公式' },
    { id: 'version', title: '版本与复测' },
    { id: 'dual', title: '双来源线隔离' },
    { id: 'cmc', title: 'CMC 只读铁律' },
    { id: 'ai-rule', title: 'AI 三铁律' },
  ] },
  { id: 'modules', title: '四、功能模块操作指引', sub: [
    { id: 'dashboard', title: '综合看板 / 产线总览' },
    { id: 'master', title: '主数据' },
    { id: 'standard', title: '动作标准库' },
    { id: 'workbench', title: '分解工作台' },
    { id: 'analysis', title: '分析结果' },
    { id: 'compare', title: '改善对比' },
    { id: 'improvements', title: '改善任务' },
    { id: 'ai-segment', title: 'AI 自动分解' },
    { id: 'ai-suggest', title: 'AI 改善建议' },
    { id: 'ai-waste', title: '浪费识别' },
    { id: 'settings', title: '设置中心' },
    { id: 'rbac', title: '用户与权限中心' },
  ] },
  { id: 'roles', title: '五、权限与角色' },
  { id: 'faq', title: '六、常见问题' },
  { id: 'appendix', title: '七、附录', sub: [
    { id: 'glossary', title: '术语表' },
    { id: 'shortcuts', title: '工作台快捷键速查' },
  ] },
];

export default function HelpPage() {
  const [active, setActive] = useState('intro');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>('.help-section'));
    if (roots.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: '-10% 0px -70% 0px', threshold: 0 },
    );
    roots.forEach((r) => obs.observe(r));
    return () => obs.disconnect();
  }, []);

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="container">
      <div className="page-head">
        <h1>系统使用帮助</h1>
        <span className="sub">IE 改善效率平台 · 面向一线 IE / 产线管理者与系统管理员的操作指引与概念说明</span>
      </div>

      <div className="help-doc">
        <nav className="help-toc no-print" aria-label="帮助目录">
          <h4>目录</h4>
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className={active === s.id ? 'active' : ''} onClick={(e) => { e.preventDefault(); go(s.id); }}>
              {s.title}
            </a>
          ))}
        </nav>

        <div className="help-main" ref={containerRef}>
          {/* ============ 一、系统简介 ============ */}
          <section id="intro" className="help-section">
            <h2>一、系统简介</h2>
            <p>
              IE 改善效率平台是一套面向工业工程（IE）场景的<strong>作业视频分解与改善分析工具</strong>。
              它把一线工位作业录像拆解为动素（动作要素）级别，自动统计增值（VA）/ 必要非增值（RNVA）/ 非增值（NVA）占比、
              线平衡率与瓶颈，并基于规则与 AI 给出改善建议、估算可节省工时。
            </p>
            <div className="help-callout">
              <span className="t">产品主线：人拆 AI 校</span>
              人负责看视频、做动作分解；AI 与规则引擎负责校验、归类、诊断与建议。AI 不替代人做判断，
              所有 AI 产出默认「待审」，确认后才进入改善闭环。
            </div>
            <p>典型使用闭环：</p>
            <ol>
              <li><strong>定对象</strong>：在「产线总览」新建或选择一个工位。</li>
              <li><strong>测现状</strong>：进入「分解工作台」，对照视频逐段打点，记录每个动作要素。</li>
              <li><strong>出方案</strong>：在「分析结果」查看指标，一键生成 AI 改善建议 / 浪费识别，确认后进入「改善任务」跟踪。</li>
            </ol>
          </section>

          {/* ============ 二、快速上手 ============ */}
          <section id="start" className="help-section">
            <h2>二、快速上手（五步）</h2>
            <div className="help-card-grid">
              <div className="help-card">
                <h4>1 · 登录</h4>
                <p>使用管理员分配的账号登录。初始口令 <code>123456</code>，<strong>首次登录会被要求强制改密</strong>。</p>
              </div>
              <div className="help-card">
                <h4>2 · 进首页</h4>
                <p>登录后按权限自动进入「综合看板」或「产线总览」。顶部导航跨页常驻，可随时切换。</p>
              </div>
              <div className="help-card">
                <h4>3 · 建工位</h4>
                <p>在「产线总览」点「+ 新建工位」，按 工厂 → 产线 → 项目 → 工位 四段式创建。</p>
              </div>
              <div className="help-card">
                <h4>4 · 分解</h4>
                <p>打开工位 →「分解工作台」，载入作业视频，逐段打点记录动作要素并提交。</p>
              </div>
              <div className="help-card">
                <h4>5 · 改善</h4>
                <p>在「分析结果」看指标，生成 AI 建议 / 浪费识别，确认改善项后到「改善任务」跟踪落地。</p>
              </div>
            </div>
            <div className="help-callout">
              工作台内按 <span className="help-kbd">?</span> 可随时打开<strong>快捷键帮助浮层</strong>，本页是覆盖全系统的使用帮助。
            </div>
          </section>

          {/* ============ 三、核心概念 ============ */}
          <section id="concepts" className="help-section">
            <h2>三、核心概念</h2>

            <h3 id="motion">3.1 动素三分法</h3>
            <p>系统把动作要素按价值属性分为三类，这是所有分析与改善建议的基础口径：</p>
            <table className="help-table">
              <thead><tr><th>类别</th><th>含义</th><th>改善方向</th><th>典型动作</th></tr></thead>
              <tbody>
                <tr><td><span className="help-tag" style={{ color: 'var(--teal)' }}>VA</span> 增值</td><td>直接改变产品形态/功能、客户愿付费的动作</td><td>保留、优化路径</td><td>装配、使用、检查、粘贴、涂</td></tr>
                <tr><td><span className="help-tag" style={{ color: 'var(--amber)' }}>RNVA</span> 必要非增值</td><td>Required Non-Value Added，当前工艺下必需（检查、必要移物、人机配合等待）</td><td>压缩、合并、重排，<strong>不能直接删</strong></td><td>寻找、选择、思考、预置、目检、按、压、移物</td></tr>
                <tr><td><span className="help-tag" style={{ color: 'var(--red)' }}>NVA</span> 非增值</td><td>纯浪费</td><td>优先直接消除</td><td>持住、延迟、等待、走动、寻找</td></tr>
              </tbody>
            </table>
            <p>系统中颜色约定：VA 青色、RNVA 琥珀色、NVA 红色；比例与节拍（CT）、总工时（TT）共同构成线平衡分析。</p>

            <h3 id="va-rule">3.2 增值判定与改判</h3>
            <p>
              每个动作类型的 VA / RNVA / NVA 归属由<strong>规则表（va_rules）</strong>统一决定（可在「动作标准库」配置并发布版本）。
              若该类型未直接命中规则，系统按经典动素默认归类（如「其他」默认归 RNVA）。
            </p>
            <div className="help-callout warn">
              <span className="t">改判需留痕</span>
              在分解工作台把某要素从原归类改判为另一类时，必须填写结构化理由，格式为
              <code> [VA改判|原:x|新:y|理由:z|人:w|日期] </code>。
              未附理由的改判会被后端拦截（V1 校验），以保证判定可追溯。
            </div>

            <h3 id="benefit">3.3 收益公式</h3>
            <p>单条改善的年度可节省工时按下式计算（全部由服务端计算，前端不产数字）：</p>
            <div className="help-callout">
              节省秒数 × 日产量 × 365 × 费率（元/小时） ÷ 3600 × 落地率
            </div>
            <p>
              其中<strong>日产量</strong>与<strong>费率（元/小时）</strong>没有默认值，必须在「设置中心」按产线维护；
              未配置时系统会<strong>阻断计算并提示</strong>，绝不臆测。
            </p>

            <h3 id="version">3.4 版本与复测</h3>
            <p>
              工位的分解数据用<strong>版本号</strong>管理，版本号代表「复测代数」。每次复测会让版本 +1 并<strong>封存旧版</strong>（旧版只读）；
              新录入只能写入当前最新版本（写守卫 <code>bol_version = station.version</code>）。
            </p>
            <ul>
              <li>封存版不可再编辑，保证历史对比可靠。</li>
              <li>空版本会被后端以 400 拦截，防止版本无限堆积。</li>
              <li>「改善对比」可在任意两个版本之间做差异比对。</li>
            </ul>

            <h3 id="dual">3.5 双来源线隔离</h3>
            <p>
              系统区分<strong>手工分解</strong>与<strong>AI 自动分解</strong>两条数据线，边界严格隔离：
            </p>
            <table className="help-table">
              <thead><tr><th>来源标识</th><th>含义</th><th>适用场景</th></tr></thead>
              <tbody>
                <tr><td><code>manual</code></td><td>人工在工作台录入</td><td>一线 IE 手拆</td></tr>
                <tr><td><code>ai_assisted</code></td><td>AI 自动分解产出</td><td>AI 自动分解页生成</td></tr>
                <tr><td><code>mixed</code></td><td>全量（手工 + AI）</td><td>AI 建议/浪费识别的默认分析口径</td></tr>
              </tbody>
            </table>
            <p>
              AI 自动分解写入时，会先封存当前手工版本、再开新版本独占写入 AI 要素，手工数据不会被动覆盖；
              手工提交也不会被静默翻转为 AI 来源。
            </p>

            <h3 id="cmc">3.6 CMC 只读铁律</h3>
            <p>
              公司的工厂 / 产线 / 项目 / 产线-工位分配关系以<strong>产能系统（CMC）为唯一数据源</strong>。
              本平台对 CMC 库<strong>全程只读（SELECT-only），绝不回写</strong>；本平台只维护分析用的工位与要素。
              若 CMC 不可达，系统会明确提示「宁缺勿错」，不会伪造主数据。
            </p>

            <h3 id="ai-rule">3.7 AI 三铁律</h3>
            <ul>
              <li><strong>永远待审</strong>：AI 改善建议与浪费识别结果默认「待审」，人工确认后才进入改善任务。</li>
              <li><strong>LLM 禁产数字</strong>：定量结论（节省工时、优先级、等级）一律由规则引擎计算，大模型只负责文案/分类。</li>
              <li><strong>模拟值不回写 ST</strong>：AI 推演的模拟值不会写回正式标准工时（ST）。</li>
            </ul>
          </section>

          {/* ============ 四、功能模块 ============ */}
          <section id="modules" className="help-section">
            <h2>四、功能模块操作指引</h2>

            <h3 id="dashboard">4.1 综合看板 / 产线总览（首页）</h3>
            <ul>
              <li><strong>综合看板（#/dashboard）</strong>：跨公司 / 跨工艺 / 跨产品的聚合视图，含 KPI、五维分布与产线横评表（按平衡率升序）。
                仅含聚合指标，不含工位要素明细；顶部五维筛选（大区 / 公司 / 工艺 / 产品 / 项目）联动全页。</li>
              <li><strong>产线总览（#/stations）</strong>：左侧对象树按 工厂 → 产线 → 工位 三级展开；上方「我的 / 共享给我 / 全部」视角切换（全部仅管理员可见）。
                卡片支持编辑、删除、共享、CSV 导入。</li>
            </ul>

            <h3 id="master">4.2 主数据（#/master）</h3>
            <p>查看工厂 / 产线 / 项目等主数据。数据来源于 CMC（只读），用于新建工位时选择归属。本平台不在此维护主数据。</p>

            <h3 id="standard">4.3 动作标准库（#/standard）</h3>
            <p>维护动作标准（motion_standard）与增值判定规则（va_rules）。修改规则后需<strong>发布（publish）</strong>才会升版本号（rv）并生效；
              未发布的改动静默不生效。可查看规则历史版本。</p>

            <h3 id="workbench">4.4 分解工作台（#/workbench/:id）</h3>
            <p>核心作业面：载入工位作业视频，逐段打点记录动作要素。常用操作：</p>
            <ul>
              <li>载入视频：支持主流格式；如浏览器不能原生解码会自动转码后播放。</li>
              <li>打点分解：用播放头定位起止点，新增要素并填写类型 / 对象 / 手别 / 描述。</li>
              <li>连续生成：新增片段默认接续上一要素止点，编号自动 +1。</li>
              <li>对象智能预填：依上一动作 → 本动作映射预填对象，需确认的会给琥珀提示。</li>
              <li>复用要素：可从历史版本 / 同线工位复用，追加或替换。</li>
              <li>VA 改判：选中要素改归类须填理由（见 3.2）。</li>
              <li>提交 / 复测：提交写入当前版本；复测会封存旧版并开新版。</li>
              <li>一键清空草稿：仅清本地未提交草稿，已提交版本不受影响。</li>
              <li>CSV 导入 / 导出：批量载入或备份既有分解数据。</li>
            </ul>
            <p>完整快捷键见<a href="#shortcuts" onClick={(e) => { e.preventDefault(); go('shortcuts'); }}>附录 · 工作台快捷键速查</a>；工作台内按 <span className="help-kbd">?</span> 也可查看。</p>

            <h3 id="analysis">4.5 分析结果（#/analysis/:id）</h3>
            <ul>
              <li>即时指标：要素数、CT、TT、VA 占比、异常项。</li>
              <li>山积图（Yamazumi）、动作能量图、双手图：可视化各工位 / 双手负荷与节拍分布。</li>
              <li>动作分析明细：按 seq 列出 作业内容 / 分类 / 浪费类型 / 改善方向（与 Excel 动作分析表同构）。</li>
              <li>瓶颈与平衡率：识别产线瓶颈工位，给出平衡率。</li>
            </ul>

            <h3 id="compare">4.6 改善对比（#/diff/:id/:vA/:vB）</h3>
            <p>选择同一工位的任意两个版本做差异比对：按 LCS 配对要素，标注新增 / 删除 / 修改 / 不变，汇总 CT 变化，并生成 ECN 说明话术，可导出 CSV。</p>

            <h3 id="improvements">4.7 改善任务（#/improvements）</h3>
            <p>跨公司聚合所有已确认的改善项，三态流转（待实施 / 已实施 / 已忽略），支持 CSV 导出。只有人工确认后的 AI 建议 / 浪费识别项才会出现在这里。</p>

            <h3 id="ai-segment">4.8 AI 自动分解（#/ai-segment/:id）</h3>
            <p>与分解工作台并列的独立页面，用浏览器端模型（手部关键点 / 运动能量）对视频做<strong>切分候选</strong>，由人确认采纳：</p>
            <ul>
              <li><strong>检测器</strong>：默认「运动能量」，可选「手部关键点」（手套低对比场景建议用运动能量）。</li>
              <li><strong>候选表</strong>：列出候选止点、手别、推断类型与描述骨架；可勾选、改手别 / 类型 / 描述。</li>
              <li><strong>HOI 对象</strong>：在工位标定「操作区」与「功能区子区」后，候选可自动推断对象（如「拿取[对象于：料盒]」）。</li>
              <li><strong>SOP 对齐</strong>：维护标准作业步骤词表，候选命中步骤时自动命名，并提示漏步 / 重复。</li>
              <li><strong>写入</strong>：采纳后封存当前手工版本、开新版独占写入 AI 要素（来源 <code>ai_assisted</code>），不会污染手工数据。</li>
            </ul>
            <div className="help-callout warn">
              <span className="t">注意</span>
              AI 自动分解只产出「候选」，需人工逐条确认；候选不直接进正式分解，未确认的不会被提交。
            </div>

            <h3 id="ai-suggest">4.9 AI 改善建议（#/ai-suggestions/:id）</h3>
            <ul>
              <li><strong>AI 配置（#/ai-config）</strong>：维护 LLM 网关（多组连接配置，单次仅一个生效）、密钥、模型；可做「连接测试」（最小代价探活）与「AI 功能自测」（用迷你样例走真实全链、不落库不扣配额）。</li>
              <li><strong>生成建议</strong>：对当前工位要素调用 LLM，经三轮校验（R1 结构 / R2 语义 / R3 数值）后产出候选建议。</li>
              <li><strong>红线与采纳</strong>：违反规则的建议被标记红线；确认采纳后才复制进改善任务（来源 <code>ai</code>），否决 / 忽略保留待审态。</li>
              <li>配额按用户限制调用次数，超额会拦截。</li>
            </ul>

            <h3 id="ai-waste">4.10 浪费识别（#/ai-waste/:id）</h3>
            <p>与 AI 建议相互独立、边界清晰的模块，一次调用同时产出：</p>
            <ul>
              <li><strong>浪费点（findings）</strong>：按 6 类浪费（等待 / 搬运 / 不良 / 动作 / 库存 / 加工）标注触发点与占比。</li>
              <li><strong>问题清单（issues）</strong>：含 ECRS 改善方向（取消 / 合并 / 重排 / 简化）、预估节省与优先级，确认后进入改善任务。</li>
              <li>支持 AI 线与手工线两条来源；可整理「改善知识库」反哺后续分析。</li>
            </ul>

            <h3 id="settings">4.11 设置中心（#/settings）</h3>
            <p>维护<strong>收益参数</strong>（按产线的日产量、费率等，未配置会阻断收益计算）与<strong>规则库</strong>查看 / 发布。按权限分 tab 展示。</p>

            <h3 id="rbac">4.12 用户与权限中心（#/admin-users）</h3>
            <p>系统管理员在此管理账号、角色与审计：</p>
            <ul>
              <li>账号：审批注册、建号、分配角色、启停、代重置密码 / 下发重置码。</li>
              <li>角色与权限矩阵：按模块分组维护权限点，可查看权限变更审计。</li>
              <li>个人工作台归属：工位支持「我的 / 共享给我 / 全部」视角，以及工位级、产线级共享协作。</li>
            </ul>
          </section>

          {/* ============ 五、权限与角色 ============ */}
          <section id="roles" className="help-section">
            <h2>五、权限与角色</h2>
            <p>系统采用 RBAC（基于角色的访问控制）+ 多租户隔离，共 5 类角色、25 个权限点：</p>
            <table className="help-table">
              <thead><tr><th>角色</th><th>典型职责</th></tr></thead>
              <tbody>
                <tr><td>sys_admin / ie_admin</td><td>全量权限：用户、角色、主数据、所有工位与 AI 功能</td></tr>
                <tr><td>ie（IE 工程师）</td><td>建工位、分解、分析、生成并确认改善建议</td></tr>
                <tr><td>leader（产线管理者）</td><td>查看看板与改善任务，关注平衡率与瓶颈</td></tr>
                <tr><td>viewer（只读）</td><td>查看名称、指标与聚合，无编辑 / 生成权限</td></tr>
              </tbody>
            </table>
            <ul>
              <li>无权限的数据/页面一律不请求、不展示，越权访问返回 403。</li>
              <li>同租户内按角色限定可见范围；跨租户数据隔离。</li>
              <li>工位的「我的 / 共享给我 / 全部」视角由归属（owner）与共享授权决定。</li>
            </ul>
          </section>

          {/* ============ 六、常见问题 ============ */}
          <section id="faq" className="help-section">
            <h2>六、常见问题</h2>

            <h3>Q1：改判 VA 分类时提示被拦截？</h3>
            <p>改判必须带结构化理由标记 <code>[VA改判|原:x|新:y|理由:z|人:w|日期]</code>，缺理由会被后端 V1 校验拒绝。请在改判时补全理由。</p>

            <h3>Q2：为什么收益 / 节省工时算不出来？</h3>
            <p>日产量与费率（元/小时）没有默认值，需在「设置中心」按产线维护。未配置时系统会阻断计算并提示，不会臆测数字。</p>

            <h3>Q3：AI 建议为什么都是「待审」？</h3>
            <p>这是设计原则（AI 三铁律之一）：AI 只提议、不终裁。建议需人工确认采纳后才进入改善任务；否决 / 忽略保留待审态。</p>

            <h3>Q4：复测后旧数据还在吗？</h3>
            <p>在。复测会封存旧版本（只读），新录入写入最新版本。可在「改善对比」选任意两版做差异比对。</p>

            <h3>Q5：视频播不了 / 上传失败？</h3>
            <p>主流格式浏览器可原生解码；解码不了的会自动转码。超大 / 超长视频可能触发上限提示。如仍异常，优先确认文件编码与网络。</p>

            <h3>Q6：「双来源线」是什么？手工和 AI 数据会混吗？</h3>
            <p>不会。手工（manual）与 AI 自动分解（ai_assisted）两条线边界隔离：AI 写入先封存手工版再独占开新版，手工提交也不会被翻转为 AI 来源（见 3.5）。</p>

            <h3>Q7：忘记密码怎么办？</h3>
            <p>在登录页点「忘记密码」，由管理员下发 6 位重置码或代置临时口令（一次性）。重置成功后所有旧会话会被吊销。</p>
          </section>

          {/* ============ 七、附录 ============ */}
          <section id="appendix" className="help-section">
            <h2>七、附录</h2>

            <h3 id="glossary">7.1 术语表</h3>
            <table className="help-table">
              <thead><tr><th>术语</th><th>说明</th></tr></thead>
              <tbody>
                <tr><td>VA</td><td>Value Added，增值动作</td></tr>
                <tr><td>RNVA</td><td>Required Non-Value Added，必要非增值（只能压缩，不能直接删）</td></tr>
                <tr><td>NVA</td><td>Non-Value Added，非增值 / 纯浪费</td></tr>
                <tr><td>CT</td><td>Cycle Time，节拍时间（单工位作业时间）</td></tr>
                <tr><td>TT</td><td>Total Time，总工时</td></tr>
                <tr><td>线平衡率</td><td>各工位 CT 均值 / 瓶颈 CT，衡量产线负荷均衡程度</td></tr>
                <tr><td>ECRS</td><td>取消(Eliminate) / 合并(Combine) / 重排(Rearrange) / 简化(Simplify)</td></tr>
                <tr><td>CMC</td><td>产能系统，本平台主数据的唯一来源（只读）</td></tr>
                <tr><td>ST</td><td>Standard Time，标准工时</td></tr>
              </tbody>
            </table>

            <h3 id="shortcuts">7.2 工作台快捷键速查</h3>
            <table className="help-table">
              <thead><tr><th>快捷键</th><th>作用</th></tr></thead>
              <tbody>
                <tr><td><span className="help-kbd">Space</span></td><td>播放 / 暂停（选中要素时播放该片段）</td></tr>
                <tr><td><span className="help-kbd">L</span></td><td>按住前进播放，松开即停</td></tr>
                <tr><td><span className="help-kbd">J</span></td><td>按住倒放（<span className="help-kbd">Shift</span>+<span className="help-kbd">J</span> = 一步 10 帧）</td></tr>
                <tr><td><span className="help-kbd">K</span></td><td>暂停</td></tr>
                <tr><td><span className="help-kbd">←</span> <span className="help-kbd">→</span></td><td>逐帧进退</td></tr>
                <tr><td><span className="help-kbd">Shift</span>+<span className="help-kbd">←</span> <span className="help-kbd">→</span></td><td>按秒跳转</td></tr>
                <tr><td><span className="help-kbd">↑</span> <span className="help-kbd">↓</span></td><td>跳到上一 / 下一要素边界</td></tr>
                <tr><td><span className="help-kbd">I</span> / <span className="help-kbd">O</span></td><td>设起点 / 设止点（先 <span className="help-kbd">←</span><span className="help-kbd">→</span> 逐帧对准）</td></tr>
                <tr><td><span className="help-kbd">,</span> <span className="help-kbd">.</span> / <span className="help-kbd">[</span> <span className="help-kbd">]</span></td><td>起点 / 止点 ±1 帧（<span className="help-kbd">Shift</span> = 10 帧）</td></tr>
                <tr><td><span className="help-kbd">F</span></td><td>全屏工作台</td></tr>
                <tr><td><span className="help-kbd">S</span></td><td>在播放头分割要素</td></tr>
                <tr><td><span className="help-kbd">N</span> / <span className="help-kbd">D</span></td><td>新增要素 / 同上新增（沿用末条属性）</td></tr>
                <tr><td><span className="help-kbd">1</span> <span className="help-kbd">2</span> <span className="help-kbd">3</span></td><td>手别：左 / 右 / 双</td></tr>
                <tr><td><span className="help-kbd">Del</span></td><td>删除选中要素（30 秒内可撤销）</td></tr>
                <tr><td><span className="help-kbd">Ctrl</span>+<span className="help-kbd">Enter</span></td><td>完成·下一个（记录本条并跳下一要素）</td></tr>
                <tr><td><span className="help-kbd">Ctrl</span>+<span className="help-kbd">K</span></td><td>打开工具箱</td></tr>
                <tr><td><span className="help-kbd">?</span></td><td>打开快捷键帮助浮层</td></tr>
              </tbody>
            </table>
            <p className="muted">注：输入框聚焦时全局快捷键会暂时让位给文本编辑，完成输入后再按快捷键即可。</p>
          </section>
        </div>
      </div>
    </div>
  );
}
