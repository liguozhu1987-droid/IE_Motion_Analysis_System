import SelectMenu, { type SelectOption } from './SelectMenu';

interface Props {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (v: string) => void;
  /** 空值项的展示文案，默认「全部」；空值 = 不过滤（语义同原生 select 的 value=""） */
  placeholder?: string;
  /** 触发器宽度（px）。不传则按 .filter-item .sm-trigger 的 min-width:112px 自适应 */
  width?: number;
}

/**
 * 筛选条自绘下拉（v3.59 收口）：统一包装 SelectMenu，处理「全部」空值语义 + .filter-item 标签布局。
 *
 * 为什么存在：本项目「原生 <select> 下拉飞走」已复发至少两轮（v3.21 新建分析对象弹窗、
 * v3.59 集团看板筛选条），根因是 Chromium 在 DPI/缩放/transform 容器下原生 popup 定位漂移，
 * 飘到窗口左上角，CSS 侧无解。所有筛选条必须走本组件（或 SelectMenu/TypeSelect），
 * 禁止再写原生 <select>——见 MEMORY.md「避坑指南（复发类）」。
 */
export default function FilterSelect({ label, value, options, onChange, placeholder = '全部', width }: Props) {
  return (
    <label className="filter-item">
      <span>{label}</span>
      <SelectMenu
        ariaLabel={`按${label}筛选`}
        value={value}
        placeholder={placeholder}
        options={[{ value: '', label: placeholder }, ...options]}
        onChange={onChange}
        triggerStyle={width ? { width } : undefined}
      />
    </label>
  );
}
