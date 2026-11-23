#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
动作分析改善措施清单 Excel 生成器（通用版 / 公式联动版 / 适用性确认版 / 样式精修版）

分析流程（与 SKILL.md 一致）：
    动素增值分析(VA/RNVA/NVA) → 5W2H提问(按要素性质) → 识别问题
    → ECRS拟定改善方案 → 用户在「是否适用」选择 → 适用者填写「预期缩短或消除(秒)」
    → 汇总指标自动联动更新

输出 5 个工作表：汇总指标 / 动素增值分析 / 5W2H提问 / 改善措施清单 / 口径与说明

样式规范（本版精修）：
1) 双行表头：改善措施清单首行为区带横幅——A:L「拟定改善方案（分析拟定区）」、
   M:N「评审确认区（请在此选择并填写）」，第二行为列表头；
2) 行高自适应：按换行列文本显示宽度（CJK 按 2 单位）估算行数，逐行设定高度，
   避免 Excel 打开时长短行参差不齐；
3) 配色轻量化：节标题改为浅蓝底+深蓝字，斑马纹改浅蓝灰，边框统一浅蓝灰；
4) 用户输入区（M/N列）金色虚线边框 + 黄色底，与公式区视觉区分；
5) 打印设置：横向、一页宽、标题行重复。

公式联动要点：
- 汇总指标全部写 Excel 公式（COUNTIF/SUMIF/COUNTIFS/SUM/COUNTA/IF+OR 保护）；
- 「增值性」代码列由「三类归属」公式自动推导（VA/RNVA/NVA）；
- 「已确认节省」= SUMIF(是否适用="适用", 预期秒数)，只统计适用项；
- 生成后把 Python 侧算好的值注入 <f> 对应的 <v> 节点（字符串结果设 t="str"），
  预览器与 data_only=True 打开即显示数值；
- 交叉校验：明细「测算可优化秒」合计 == 措施「测算参考秒」合计，不等拒绝生成。

用法：
    python build_checklist.py <data.json>
"""
import json
import math
import os
import sys
import zipfile
import xml.etree.ElementTree as ET

try:
    import openpyxl
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "openpyxl>=3.1.0"])
    import openpyxl

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.formatting.rule import FormulaRule
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.properties import PageSetupProperties
from openpyxl.chart import BarChart, Reference

SML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
RNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
ET.register_namespace("", SML_NS)

# (sheet名, 坐标) -> 缓存值；写公式时同步登记，生成末尾统一注入
CACHE = {}


def put(ws, coord, formula, cached_value):
    """写 Excel 公式并登记其缓存值"""
    ws[coord] = formula
    CACHE[(ws.title, coord)] = cached_value


def xl_color(css_hex: str) -> str:
    v = css_hex.removeprefix("#").upper()
    if len(v) != 6:
        raise ValueError(f"Expected #RRGGBB, got {css_hex}")
    return "FF" + v


# ── 配色体系 ──
NAVY = xl_color("#1F3864")          # 标题条 / 强调文字
PRIMARY = xl_color("#4472C4")       # 列表头
LIGHT = xl_color("#D9E2F3")         # 节标题底 / 合计行底
WHITE = xl_color("#FFFFFF")
BORDER_C = xl_color("#C5CEDB")      # 统一浅蓝灰边框
TEXT = xl_color("#1A1A1A")
ZEBRA = xl_color("#F5F8FC")         # 斑马纹（浅蓝灰）
CALC = xl_color("#FFF2CC")          # 黄色：公式 / 用户输入区
GOLD = xl_color("#BF8F00")          # 输入区虚线边框
GREEN_BG, GREEN_FG = xl_color("#C6EFCE"), xl_color("#375623")
YELLOW_BG, YELLOW_FG = xl_color("#FFEB9C"), xl_color("#7F6000")
RED_BG, RED_FG = xl_color("#FFC7CE"), xl_color("#833C00")

THIN = Side(style="thin", color=BORDER_C)
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
DASH = Side(style="medium", color=GOLD)
INPUT_BORDER = Border(left=DASH, right=DASH, top=DASH, bottom=DASH)

FONT_NAME = "微软雅黑"
H_FONT = Font(name=FONT_NAME, size=10, bold=True, color=WHITE)
B_FONT = Font(name=FONT_NAME, size=10, color=TEXT)
TITLE_FONT = Font(name=FONT_NAME, size=14, bold=True, color=WHITE)
SEC_FONT = Font(name=FONT_NAME, size=11, bold=True, color=NAVY)
BOLD = Font(name=FONT_NAME, size=10, bold=True, color=TEXT)
NOTE_FONT = Font(name=FONT_NAME, size=9, color=TEXT)
FMT1, FMT2, FMTPCT, FMTINT = "0.0", "0.00", "0.00%", "0"

# ── 两套正交分类体系 ──
# 主分类维度（精益增值三分法，汇总统计用）
VCATS = ["增值(VA)", "必要非增值(RNVA)", "非增值(NVA)"]
VCAT_CODES = {"增值(VA)": "VA", "必要非增值(RNVA)": "RNVA", "非增值(NVA)": "NVA"}
V_PRINCIPLES = {"增值(VA)": "尽量缩短", "必要非增值(RNVA)": "尽量取消，无法取消则尽量缩短",
                "非增值(NVA)": "尽量消除"}
# 动素学三分类（18动素学口径，按动素名称客观判定，与增值性正交，另列不参与增值比例）
THERB_CATS = ["有效动素", "辅助动素", "无效动素"]
THERB_EFF = ("伸手", "握取", "移物", "放置", "定位", "松手", "放手", "检查", "装配", "使用", "拆卸")
THERB_AUX = ("寻找", "发现", "选择", "思考", "预置")
THERB_NON = ("持住", "迟延", "延迟", "等待")
BATCHES = ["当周", "2-4周", "1-2月", "长期"]


def therbligin_category(name: str) -> str:
    """按动素名称客观判定动素学三分类（与增值性正交）"""
    s = name or ""
    if any(k in s for k in THERB_EFF):
        return "有效动素"
    if any(k in s for k in THERB_AUX):
        return "辅助动素"
    if any(k in s for k in THERB_NON):
        return "无效动素"
    return ""


def therbligin_formula(coord: str) -> str:
    """由「动素名称」单元格公式客观推导动素类别"""
    ors = lambda kws: ",".join(f'ISNUMBER(SEARCH("{k}",{coord}))' for k in kws)
    return (f'=IF({coord}="","",IF(OR({ors(THERB_EFF)}),"有效动素",'
            f'IF(OR({ors(THERB_AUX)}),"辅助动素",IF(OR({ors(THERB_NON)}),"无效动素",""))))')


def header(ws, row, n):
    for c in range(1, n + 1):
        cell = ws.cell(row=row, column=c)
        cell.font, cell.border = H_FONT, BORDER
        cell.fill = PatternFill("solid", fgColor=PRIMARY)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = 30


def banner(ws, row, spans):
    """区带横幅：spans = [(起列, 止列, 文字, 底色, 字色), ...]"""
    for c1, c2, text, bg, fg in spans:
        ws.merge_cells(start_row=row, start_column=c1, end_row=row, end_column=c2)
        c = ws.cell(row=row, column=c1, value=text)
        c.font = Font(name=FONT_NAME, size=10, bold=True, color=fg)
        c.fill = PatternFill("solid", fgColor=bg)
        c.alignment = Alignment(horizontal="center", vertical="center")
        for cc in range(c1, c2 + 1):
            ws.cell(row=row, column=cc).border = BORDER
    ws.row_dimensions[row].height = 22


def section(ws, row, text, n):
    """轻量化节标题：浅蓝底 + 深蓝粗体字"""
    ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=n)
    c = ws.cell(row=row, column=1, value=text)
    c.font, c.fill = SEC_FONT, PatternFill("solid", fgColor=LIGHT)
    c.alignment = Alignment(horizontal="left", vertical="center", indent=1)
    for cc in range(1, n + 1):
        ws.cell(row=row, column=cc).border = BORDER
    ws.row_dimensions[row].height = 22


def data_style(ws, r, n, wrap=(), center=(), fmt=None):
    for c in range(1, n + 1):
        cell = ws.cell(row=r, column=c)
        cell.font, cell.border = B_FONT, BORDER
        cell.alignment = Alignment(horizontal="center" if c in center else "left",
                                   vertical="center", wrap_text=c in wrap)
        if fmt and c in fmt:
            cell.number_format = fmt[c]
        if r % 2 == 0:
            cell.fill = PatternFill("solid", fgColor=ZEBRA)


def widths(ws, spec):
    for col, w in spec.items():
        ws.column_dimensions[col].width = w


def _disp_units(s: str) -> int:
    """显示宽度：CJK 全角按 2 单位，其余按 1"""
    return sum(2 if ord(ch) > 0x2E7F else 1 for ch in s)


def fit_row(ws, r, spec, minh=20, maxh=120, line=14.0, pad=8):
    """按换行列文本估算行数并设定行高。spec: {列号: 可用字符宽度}"""
    lines = 1
    for c, w in spec.items():
        v = ws.cell(row=r, column=c).value
        if isinstance(v, str) and v:
            for seg in v.split("\n"):
                lines = max(lines, math.ceil(_disp_units(seg) / max(w, 4)))
    ws.row_dimensions[r].height = min(max(minh, lines * line + pad), maxh)


def cf_exact(ws, col, r1, r2, mapping):
    for value, (bg, fg) in mapping.items():
        ws.conditional_formatting.add(
            f"{col}{r1}:{col}{r2}",
            FormulaRule(formula=[f'${col}{r1}="{value}"'],
                        fill=PatternFill("solid", fgColor=bg),
                        font=Font(name=FONT_NAME, size=10, bold=True, color=fg),
                        stopIfTrue=True))


def cf_contains(ws, col, r1, r2, keyword, bg, fg):
    ws.conditional_formatting.add(
        f"{col}{r1}:{col}{r2}",
        FormulaRule(formula=[f'ISNUMBER(SEARCH("{keyword}",${col}{r1}))'],
                    fill=PatternFill("solid", fgColor=bg),
                    font=Font(name=FONT_NAME, size=10, bold=True, color=fg),
                    stopIfTrue=True))


def print_setup(ws, title_rows="1:1"):
    ws.sheet_view.showGridLines = False
    ws.print_title_rows = title_rows
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)


def inject_cache(path):
    """把 CACHE 中的值写入 xlsx 公式单元格的 <v>，保留公式文本不变。
    字符串结果须设 t="str"，数值结果为默认类型。"""
    with zipfile.ZipFile(path, "r") as zin:
        names = zin.namelist()
        blobs = {n: zin.read(n) for n in names}
    wbroot = ET.fromstring(blobs["xl/workbook.xml"])
    relsroot = ET.fromstring(blobs["xl/_rels/workbook.xml.rels"])
    relmap = {r.get("Id"): r.get("Target") for r in relsroot}
    sheetmap = {}
    for sh in wbroot.find(f"{{{SML_NS}}}sheets"):
        target = relmap[sh.get(f"{{{RNS}}}id")]
        target = target.lstrip("/") if target.startswith("/") else "xl/" + target.lstrip("/")
        sheetmap[sh.get("name")] = target

    per_sheet = {}
    for (sname, coord), val in CACHE.items():
        per_sheet.setdefault(sheetmap.get(sname, ""), {})[coord] = val

    injected = 0
    for xpath, mapping in per_sheet.items():
        if not xpath or xpath not in blobs:
            continue
        root = ET.fromstring(blobs[xpath])
        for c in root.iter(f"{{{SML_NS}}}c"):
            coord = c.get("r")
            if coord not in mapping:
                continue
            f = c.find(f"{{{SML_NS}}}f")
            if f is None:
                continue
            v = c.find(f"{{{SML_NS}}}v")
            if v is None:
                v = ET.SubElement(c, f"{{{SML_NS}}}v")
            val = mapping[coord]
            if isinstance(val, str):
                c.set("t", "str")
                v.text = val
            else:
                if "t" in c.attrib:
                    del c.attrib["t"]
                v.text = repr(val) if isinstance(val, float) else str(val)
            injected += 1
        blobs[xpath] = ET.tostring(root, encoding="utf-8", xml_declaration=True)

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in names:
            zout.writestr(n, blobs[n])
    return injected


def build(d: dict):
    title = d["title"]
    motion = d["motion_rows"]
    w2h = d["w2h_rows"]
    measures = d["measures"]
    batches = d.get("batches", BATCHES)
    CACHE.clear()

    # ── Python 侧统计（用于缓存值与交叉校验）──
    total_ct = round(sum(r[2] for r in motion), 2)
    save_total = round(sum(r[7] for r in motion), 2)
    cat_n = {c: sum(1 for r in motion if r[4] == c) for c in VCATS}
    cat_t = {c: round(sum(r[2] for r in motion if r[4] == c), 2) for c in VCATS}
    cat_p = {c: cat_t[c] / total_ct if total_ct else 0.0 for c in VCATS}
    therb_cats = [therbligin_category(r[3]) for r in motion]
    therb_n = {c: therb_cats.count(c) for c in THERB_CATS}
    therb_t = {c: round(sum(r[2] for r, cc in zip(motion, therb_cats) if cc == c), 2)
               for c in THERB_CATS}
    ct_after_calc = round(total_ct - save_total, 2)
    uph_before = 3600.0 / total_ct if total_ct else 0.0
    uph_after_calc = 3600.0 / ct_after_calc if ct_after_calc else 0.0
    measure_ref = round(sum(r[11] for r in measures), 2)
    batch_n = {b: sum(1 for r in measures if r[9] == b) for b in batches}

    # 交叉校验：明细测算合计 == 措施测算参考合计
    if abs(measure_ref - save_total) > 0.005:
        raise ValueError(
            f"交叉校验失败：动素明细测算可优化合计 {save_total}s ≠ 措施测算参考合计 {measure_ref}s")

    wb = Workbook()
    wb.properties.title = title
    wb.properties.subject = "动作分解增值分析与改善措施清单（VA/RNVA/NVA + 5W2H + ECRS拟定 + 适用性确认）"
    wb.properties.creator = "WorkBuddy"

    # ════════ Sheet：动素增值分析（先建，供汇总公式引用）════════
    ws2 = wb.active
    ws2.title = "动素增值分析"
    h2 = ["STEP", "动作描述", "CT(秒)", "动素名称", "动素类别(动素学)", "类别归属(增值性)",
          "具体改善手法", "对应措施编号", "测算可优化(秒)", "时间占比"]
    ws2.append(h2)
    header(ws2, 1, len(h2))
    last = 1 + len(motion)
    tot = last + 1
    for i, row in enumerate(motion, start=2):
        # row: [STEP, 描述, CT, 动素名称, 类别归属(增值性), 具体改善手法, 对应措施编号, 测算可优化]
        for j, v in enumerate(row[:4], start=1):
            ws2.cell(row=i, column=j, value=v)
        # E 动素类别：按动素名称客观判定（公式推导，与增值性正交）
        put(ws2, f"E{i}", therbligin_formula(f"$D{i}"), therbligin_category(row[3]))
        # F 类别归属：主分类维度（增值性），数据填写 + 下拉枚举
        ws2.cell(row=i, column=6, value=row[4])
        for j, v in enumerate(row[5:], start=7):
            ws2.cell(row=i, column=j, value=v)
        put(ws2, f"J{i}", f'=IF(OR($C${tot}="",$C${tot}=0),"",C{i}/$C${tot})',
            round(row[2] / total_ct, 6) if total_ct else 0.0)
        data_style(ws2, i, len(h2), wrap=(2, 7), center=(1, 4, 5, 6, 8),
                   fmt={3: FMT2, 9: FMT2, 10: FMTPCT})
        ws2.cell(row=i, column=10).fill = PatternFill("solid", fgColor=CALC)
        ws2.cell(row=i, column=10).number_format = FMTPCT
        fit_row(ws2, i, {2: 28, 7: 44})
    ws2.cell(row=tot, column=1, value="合计")
    ws2.cell(row=tot, column=2, value=f"{len(motion)}个动作要素 / 单循环")
    put(ws2, f"C{tot}", f"=SUM(C2:C{last})", total_ct)
    put(ws2, f"I{tot}", f"=SUM(I2:I{last})", save_total)
    put(ws2, f"J{tot}", f"=SUM(J2:J{last})", 1.0)
    for c in range(1, len(h2) + 1):
        cell = ws2.cell(row=tot, column=c)
        cell.font, cell.border = BOLD, BORDER
        cell.fill = PatternFill("solid", fgColor=LIGHT)
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for c in (3, 9):
        ws2.cell(row=tot, column=c).number_format = FMT2
    ws2.cell(row=tot, column=10).number_format = FMTPCT
    ws2.row_dimensions[tot].height = 24

    dv_vcat = DataValidation(type="list", formula1='"增值(VA),必要非增值(RNVA),非增值(NVA)"',
                             allow_blank=True)
    dv_vcat.showErrorMessage = True
    dv_vcat.errorTitle, dv_vcat.error = "枚举值不符", "只能选择：增值(VA) / 必要非增值(RNVA) / 非增值(NVA)"
    ws2.add_data_validation(dv_vcat)
    dv_vcat.add(f"F2:F{last}")
    cf_exact(ws2, "E", 2, last, {"有效动素": (GREEN_BG, GREEN_FG),
                                 "辅助动素": (YELLOW_BG, YELLOW_FG),
                                 "无效动素": (RED_BG, RED_FG)})
    cf_exact(ws2, "F", 2, last, {"增值(VA)": (GREEN_BG, GREEN_FG),
                                 "必要非增值(RNVA)": (YELLOW_BG, YELLOW_FG),
                                 "非增值(NVA)": (RED_BG, RED_FG)})
    widths(ws2, {"A": 7, "B": 30, "C": 9, "D": 20, "E": 15, "F": 16,
                 "G": 42, "H": 13, "I": 14, "J": 10})
    ws2.freeze_panes, ws2.auto_filter.ref = "C2", f"A1:J{last}"
    print_setup(ws2)

    # ════════ Sheet：5W2H提问（位于改善措施之前，按要素性质提问）════════
    ws4 = wb.create_sheet("5W2H提问")
    h4 = ["疑点编号", "对应STEP", "要素性质", "5W2H提问(What/Why/Who/Where/When/How/How much)",
          "核心问题(识别的问题)", "分析结论(倾向性答案)", "对应拟定措施编号"]
    ws4.append(h4)
    header(ws4, 1, len(h4))
    for i, row in enumerate(w2h, start=2):
        for j, v in enumerate(row, start=1):
            ws4.cell(row=i, column=j, value=v)
        data_style(ws4, i, len(h4), wrap=(4, 5, 6), center=(1, 2, 3, 7))
        fit_row(ws4, i, {4: 42, 5: 38, 6: 58})
    wlast = 1 + len(w2h)
    cf_exact(ws4, "C", 2, wlast, {"VA": (GREEN_BG, GREEN_FG), "RNVA": (YELLOW_BG, YELLOW_FG),
                                  "NVA": (RED_BG, RED_FG)})
    widths(ws4, {"A": 9, "B": 12, "C": 12, "D": 44, "E": 40, "F": 60, "G": 14})
    ws4.freeze_panes, ws4.auto_filter.ref = "A2", f"A1:G{wlast}"
    print_setup(ws4)

    # ════════ Sheet：改善措施清单（双行表头：拟定区横幅 + 评审确认区横幅）════════
    ws3 = wb.create_sheet("改善措施清单")
    banner(ws3, 1, [
        (1, 12, "拟定改善方案（分析拟定区，ECRS ／ 待评审）", PRIMARY, WHITE),
        (13, 14, "评审确认区（请在此选择并填写）", GOLD, WHITE),
    ])
    h3 = ["编号", "对应5W2H", "对应STEP", "问题点(5W2H识别)", "拟定改善方案(ECRS)", "运用方法",
          "改善维度", "落地难度", "责任成员", "实施批次", "验证指标", "测算参考(秒)",
          "是否适用", "预期缩短或消除(秒)"]
    for j, v in enumerate(h3, start=1):
        ws3.cell(row=2, column=j, value=v)
    header(ws3, 2, len(h3))
    dstart = 3
    l3 = dstart + len(measures) - 1
    t3 = l3 + 1
    for i, row in enumerate(measures, start=dstart):
        # row: [编号, 对应5W2H, 对应STEP, 问题点, 拟定改善方案, 运用方法, 改善维度,
        #       落地难度, 责任成员, 实施批次, 验证指标, 测算参考秒]
        for j, v in enumerate(row, start=1):
            ws3.cell(row=i, column=j, value=v)
        data_style(ws3, i, 12, wrap=(4, 5, 6, 11), center=(1, 2, 3, 7, 8, 10), fmt={12: FMT2})
        # M/N 用户输入区：金色虚线框 + 黄色底
        for c, fmt in ((13, None), (14, FMT2)):
            cell = ws3.cell(row=i, column=c)
            cell.font, cell.alignment = B_FONT, Alignment(horizontal="center", vertical="center")
            cell.fill = PatternFill("solid", fgColor=CALC)
            cell.border = INPUT_BORDER
            if fmt:
                cell.number_format = fmt
        fit_row(ws3, i, {4: 28, 5: 40, 6: 20, 11: 32})
    ws3.cell(row=t3, column=1, value="合计")
    ws3.cell(row=t3, column=5,
             value="拟定为待评审方案：M列下拉选择是否适用，适用后在N列填写预期秒数；"
                   "措施间收益可能重叠，不作简单相加")
    put(ws3, f"L{t3}", f"=SUM(L{dstart}:L{l3})", measure_ref)
    put(ws3, f"N{t3}", f'=SUMIF(M{dstart}:M{l3},"适用",N{dstart}:N{l3})', 0.0)
    for c in range(1, len(h3) + 1):
        cell = ws3.cell(row=t3, column=c)
        cell.font, cell.border = BOLD, BORDER
        cell.fill = PatternFill("solid", fgColor=LIGHT)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws3.cell(row=t3, column=12).number_format = FMT2
    ws3.cell(row=t3, column=14).number_format = FMT2
    ws3.cell(row=t3, column=13).value = "已确认节省(适用项)→"
    ws3.row_dimensions[t3].height = 34

    dv_use = DataValidation(type="list", formula1='"适用,不适用"', allow_blank=True)
    dv_use.showErrorMessage = True
    dv_use.errorTitle, dv_use.error = "取值不符", "只能选择：适用 / 不适用（留空表示尚未评审）"
    ws3.add_data_validation(dv_use)
    dv_use.add(f"M{dstart}:M{l3}")
    cf_exact(ws3, "M", dstart, l3, {"适用": (GREEN_BG, GREEN_FG), "不适用": (GRAY := ZEBRA, NAVY)})
    cf_contains(ws3, "H", dstart, l3, "高", RED_BG, RED_FG)
    cf_contains(ws3, "H", dstart, l3, "中", YELLOW_BG, YELLOW_FG)
    cf_contains(ws3, "H", dstart, l3, "低", GREEN_BG, GREEN_FG)
    widths(ws3, {"A": 8, "B": 10, "C": 14, "D": 30, "E": 42, "F": 22, "G": 16,
                 "H": 11, "I": 18, "J": 10, "K": 34, "L": 11, "M": 10, "N": 13})
    ws3.freeze_panes, ws3.auto_filter.ref = "D3", f"A2:N{l3}"
    print_setup(ws3, title_rows="1:2")

    # ════════ Sheet：口径与说明 ════════
    ws7 = wb.create_sheet("口径与说明")
    section(ws7, 1, "一、主分类维度（增值性——汇总统计用）", 6)
    hA = ["类别", "代码", "定义", "常见动素学类别", "改善原则", "本工位典型步骤"]
    for j, v in enumerate(hA, start=1):
        ws7.cell(row=2, column=j, value=v)
    header(ws7, 2, len(hA))
    for i, row in enumerate(d["def_rows"], start=3):
        for j, v in enumerate(row, start=1):
            ws7.cell(row=i, column=j, value=v)
        data_style(ws7, i, len(hA), wrap=(3, 4, 6), center=(1, 2, 5))
        fit_row(ws7, i, {3: 44, 4: 24, 6: 32})
    cf_exact(ws7, "A", 3, 2 + len(d["def_rows"]), {"增值": (GREEN_BG, GREEN_FG),
                                                   "必要非增值": (YELLOW_BG, YELLOW_FG),
                                                   "非增值": (RED_BG, RED_FG)})
    r = 3 + len(d["def_rows"]) + 1
    section(ws7, r, "二、动素学三分类（18动素学口径，按动素名称客观判定，与增值性正交）", 6)
    hB = ["动素类别", "包含动素", "判定方式", "与增值性的关系", "本工位分布", "改善意义"]
    hb = r + 1
    for j, v in enumerate(hB, start=1):
        ws7.cell(row=hb, column=j, value=v)
    header(ws7, hb, len(hB))
    for i, row in enumerate(d["therbligin_rows"], start=hb + 1):
        for j, v in enumerate(row, start=1):
            ws7.cell(row=i, column=j, value=v)
        data_style(ws7, i, len(hB), wrap=(2, 3, 4), center=(1, 5))
        fit_row(ws7, i, {2: 24, 4: 24, 5: 14, 6: 32})
    cf_exact(ws7, "A", hb + 1, hb + len(d["therbligin_rows"]),
             {"有效动素": (GREEN_BG, GREEN_FG), "辅助动素": (YELLOW_BG, YELLOW_FG),
              "无效动素": (RED_BG, RED_FG)})
    r = hb + len(d["therbligin_rows"]) + 2
    for item in d["notes"]:
        if isinstance(item, dict):
            heading, text = item.get("heading", ""), item.get("text", "")
        else:
            heading, text = "", str(item)
        if heading:
            section(ws7, r, heading, 6)
        elif text:
            ws7.merge_cells(start_row=r, start_column=1, end_row=r, end_column=6)
            c = ws7.cell(row=r, column=1, value=text)
            c.font, c.border = NOTE_FONT, BORDER
            c.alignment = Alignment(horizontal="left", vertical="top", wrap_text=True, indent=1)
            c.fill = PatternFill("solid", fgColor=ZEBRA)
            fit_row(ws7, r, {1: 148}, line=13.0, minh=24)
        r += 1
    widths(ws7, {"A": 12, "B": 8, "C": 46, "D": 26, "E": 26, "F": 34})
    ws7.sheet_view.showGridLines = False

    # ════════ Sheet：汇总指标（置顶，全部公式引用明细与用户选择）════════
    ws1 = wb.create_sheet("汇总指标", 0)
    n = 6
    s2, s3 = "'动素增值分析'", "'改善措施清单'"
    ws1.merge_cells("A1:F1")
    c = ws1["A1"]
    c.value, c.font = title, TITLE_FONT
    c.fill = PatternFill("solid", fgColor=NAVY)
    c.alignment = Alignment(horizontal="center", vertical="center")
    ws1.row_dimensions[1].height = 36
    ws1.merge_cells("A2:F2")
    c = ws1["A2"]
    c.value = d.get("subtitle", "分析流程：动素增值分析(VA/RNVA/NVA) → 5W2H提问 → 识别问题 → "
                                "ECRS拟定改善方案 → 评审确认（M列是否适用 × N列预期秒数）｜"
                                "汇总最终结果仅联动评审确认数据，分析测算值仅作参考｜黄色单元格为公式/输入区")
    c.font, c.fill = Font(name=FONT_NAME, size=9, color=TEXT), PatternFill("solid", fgColor=LIGHT)
    c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    ws1.row_dimensions[2].height = 26

    # ── 一、核心指标·现状（联动「动素增值分析」明细，均为现状事实）──
    section(ws1, 4, "一、核心指标·现状（公式联动「动素增值分析」明细）", n)
    for j, v in enumerate(["指标", "数值", "计算口径", "说明", "", ""], start=1):
        ws1.cell(row=5, column=j, value=v)
    ws1.merge_cells("D5:F5")
    header(ws1, 5, n)
    ratio_formula = {cat: (f'=IF(OR($B$6="",$B$6=0),"",'
                           f'SUMIF({s2}!$F$2:$F${last},"{cat}",{s2}!$C$2:$C${last})/$B$6)')
                     for cat in VCATS}
    rows1 = [
        ("单循环CT现状(秒)", f"={s2}!$C${tot}", total_ct, FMT2,
         "明细「CT(秒)」合计", "数据源单循环视频分解，未含评比与宽放"),
        ("理论UPH现状(件/小时)", '=IF(OR($B$6="",$B$6=0),"",3600/$B$6)', round(uph_before, 2), FMT1,
         "3600 ÷ 现状CT", ""),
        ("增值比例(增值VA)", ratio_formula["增值(VA)"], cat_p["增值(VA)"], FMTPCT,
         "增值(VA)时间 ÷ 总CT", "主分类维度；检查(I)属有效动素但为必要非增值，不计入分子"),
        ("必要非增值占比(RNVA)", ratio_formula["必要非增值(RNVA)"], cat_p["必要非增值(RNVA)"], FMTPCT,
         "必要非增值(RNVA)时间 ÷ 总CT", "检验/扫码/按钮等必要但非增值"),
        ("非增值占比(NVA)", ratio_formula["非增值(NVA)"], cat_p["非增值(NVA)"], FMTPCT,
         "非增值(NVA)时间 ÷ 总CT", "等待/取放/步行/弯腰等纯消耗"),
        ("动作要素数(步)", f"=COUNTA({s2}!$A$2:$A${last})", len(motion), FMTINT,
         "明细有效行数", ""),
    ]
    for i, (label, formula, cached, fmt, cal, note) in enumerate(rows1, start=6):
        ws1.cell(row=i, column=1, value=label)
        put(ws1, f"B{i}", formula, cached)
        ws1.cell(row=i, column=3, value=cal)
        ws1.merge_cells(start_row=i, start_column=4, end_row=i, end_column=6)
        ws1.cell(row=i, column=4, value=note)
        data_style(ws1, i, n, wrap=(3, 4), center=(2,))
        ws1.cell(row=i, column=2).number_format = fmt
        ws1.cell(row=i, column=2).fill = PatternFill("solid", fgColor=CALC)
        fit_row(ws1, i, {1: 24, 3: 24, 4: 56}, minh=22)

    # ── 二、评审确认结果（最终口径：只联动用户确认的「是否适用」×「预期缩短或消除(秒)」）──
    section(ws1, 13, "二、评审确认结果（最终口径：联动「改善措施清单」M列是否适用 × N列预期秒数；未确认时无改善结果）", n)
    for cc in range(1, n + 1):  # 最终口径区块用金色强调，对应措施清单「评审确认区」横幅
        ws1.cell(row=13, column=cc).fill = PatternFill("solid", fgColor=GOLD)
    ws1.cell(row=13, column=1).font = Font(name=FONT_NAME, size=11, bold=True, color=WHITE)
    for j, v in enumerate(["指标", "数值", "计算口径", "说明", "", ""], start=1):
        ws1.cell(row=14, column=j, value=v)
    ws1.merge_cells("D14:F14")
    header(ws1, 14, n)
    rows2 = [
        ("拟定改善方案条数", f"=COUNTA({s3}!$A${dstart}:$A${l3})", len(measures), FMTINT,
         "清单有效行数", "全部为拟定方案，须经评审确认"),
        ("已采纳条数(是否适用=适用)", f'=COUNTIF({s3}!$M${dstart}:$M${l3},"适用")', 0, FMTINT,
         'COUNTIF(M列,"适用")', "在措施清单 M 列下拉选择后自动更新"),
        ("已确认节省合计(秒)", f'=SUMIF({s3}!$M${dstart}:$M${l3},"适用",{s3}!$N${dstart}:$N${l3})', 0.0, FMT2,
         'SUMIF(M列="适用", N列)', "唯一最终节省口径：仅统计「适用」且已在N列填写秒数的措施"),
        ("改善后CT(按已确认项,秒)", '=IF(OR($B$6="",$B$6=0),"",$B$6-$B$17)', total_ct, FMT2,
         "现状CT - 已确认节省合计", "未确认任何措施时等于现状CT，不预支未经确认的测算值"),
        ("理论UPH(按已确认项,件/小时)", '=IF(OR($B$18="",$B$18=0),"",3600/$B$18)',
         round(3600.0 / total_ct, 2), FMT1, "3600 ÷ 按已确认项改善后CT", ""),
        ("CT降幅(按已确认项)", '=IF(OR($B$6="",$B$6=0),"",$B$17/$B$6)', 0.0, FMTPCT,
         "已确认节省合计 ÷ 现状CT", "未确认时为0；只反映已确认的真实改善"),
    ]
    for i, (label, formula, cached, fmt, cal, note) in enumerate(rows2, start=15):
        ws1.cell(row=i, column=1, value=label)
        put(ws1, f"B{i}", formula, cached)
        ws1.cell(row=i, column=3, value=cal)
        ws1.merge_cells(start_row=i, start_column=4, end_row=i, end_column=6)
        ws1.cell(row=i, column=4, value=note)
        data_style(ws1, i, n, wrap=(3, 4), center=(2,))
        ws1.cell(row=i, column=2).number_format = fmt
        ws1.cell(row=i, column=2).fill = PatternFill("solid", fgColor=CALC)
        fit_row(ws1, i, {1: 24, 3: 24, 4: 56}, minh=22)

    # ── 三、主分类统计·增值性（汇总统计维度，联动明细F列「类别归属」）──
    section(ws1, 22, "三、主分类统计·增值性（汇总统计维度，COUNTIF/SUMIF 联动明细「类别归属」）", n)
    for j, v in enumerate(["类别", "代码", "步数", "时间(秒)", "占比", "改善原则"], start=1):
        ws1.cell(row=23, column=j, value=v)
    header(ws1, 23, n)
    for i, cat in enumerate(VCATS, start=24):
        ws1.cell(row=i, column=1, value=cat)
        ws1.cell(row=i, column=2, value=VCAT_CODES[cat])
        put(ws1, f"C{i}", f"=COUNTIF({s2}!$F$2:$F${last},A{i})", cat_n[cat])
        put(ws1, f"D{i}", f"=SUMIF({s2}!$F$2:$F${last},A{i},{s2}!$C$2:$C${last})", cat_t[cat])
        put(ws1, f"E{i}", f'=IF(OR($D$27="",$D$27=0),"",D{i}/$D$27)', cat_p[cat])
        ws1.cell(row=i, column=6, value=V_PRINCIPLES[cat])
        data_style(ws1, i, n, wrap=(6,), center=(2, 3, 4, 5))
        for cc, fmt in ((3, FMTINT), (4, FMT2), (5, FMTPCT)):
            ws1.cell(row=i, column=cc).number_format = fmt
            ws1.cell(row=i, column=cc).fill = PatternFill("solid", fgColor=CALC)
        fit_row(ws1, i, {1: 24, 6: 20}, minh=22)
    ws1.cell(row=27, column=1, value="合计")
    ws1.cell(row=27, column=2, value="—")
    put(ws1, "C27", "=SUM(C24:C26)", len(motion))
    put(ws1, "D27", "=SUM(D24:D26)", total_ct)
    put(ws1, "E27", "=SUM(E24:E26)", 1.0)
    ws1.cell(row=27, column=6, value="时间合计应等于单循环CT")
    for cc in range(1, n + 1):
        cell = ws1.cell(row=27, column=cc)
        cell.font, cell.border = BOLD, BORDER
        cell.fill = PatternFill("solid", fgColor=LIGHT)
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    for cc, fmt in ((3, FMTINT), (4, FMT2), (5, FMTPCT)):
        ws1.cell(row=27, column=cc).number_format = fmt
    cf_exact(ws1, "A", 24, 26, {"增值(VA)": (GREEN_BG, GREEN_FG),
                                "必要非增值(RNVA)": (YELLOW_BG, YELLOW_FG),
                                "非增值(NVA)": (RED_BG, RED_FG)})

    # ── 四、动素学三分类（正交维度，按动素名称客观判定，另列不参与增值比例）──
    section(ws1, 29, "四、动素学三分类（正交维度，按动素名称客观判定；另列统计，不参与增值比例计算）", n)
    for j, v in enumerate(["动素类别", "步数", "时间(秒)", "包含动素与正交关系", "", ""], start=1):
        ws1.cell(row=30, column=j, value=v)
    ws1.merge_cells("D30:F30")
    header(ws1, 30, n)
    therb_info = {
        "有效动素": "伸手(TE)、握取(G)、移物(TL)、放置、定位(P)、松手(RL)、检查(I)、装配(A)、使用(U)、拆卸(DA)；与增值性正交——检查(I)属有效动素但为必要非增值(RNVA)，伸手/握取/移物/放手多为非增值(NVA)",
        "辅助动素": "寻找(SH)、发现(F)、选择(ST)、思考(PN)、预置(PP)；属附带性动素，本工位未观测到",
        "无效动素": "持住(H)、可避免延迟(AD)、不可避免延迟(UD)、等待；无效动素必为非增值(NVA)，但非增值不一定是无效动素（如检查）",
    }
    for i, cat in enumerate(THERB_CATS, start=31):
        ws1.cell(row=i, column=1, value=cat)
        put(ws1, f"B{i}", f"=COUNTIF({s2}!$E$2:$E${last},A{i})", therb_n[cat])
        put(ws1, f"C{i}", f"=SUMIF({s2}!$E$2:$E${last},A{i},{s2}!$C$2:$C${last})", therb_t[cat])
        ws1.merge_cells(start_row=i, start_column=4, end_row=i, end_column=6)
        ws1.cell(row=i, column=4, value=therb_info[cat])
        data_style(ws1, i, n, wrap=(4,), center=(2, 3))
        for cc, fmt in ((2, FMTINT), (3, FMT2)):
            ws1.cell(row=i, column=cc).number_format = fmt
            ws1.cell(row=i, column=cc).fill = PatternFill("solid", fgColor=CALC)
        fit_row(ws1, i, {4: 58}, minh=22)
    ws1.cell(row=34, column=1, value="合计")
    put(ws1, "B34", "=SUM(B31:B33)", len(motion))
    put(ws1, "C34", "=SUM(C31:C33)", total_ct)
    for cc in range(1, 4):
        cell = ws1.cell(row=34, column=cc)
        cell.font, cell.border = BOLD, BORDER
        cell.fill = PatternFill("solid", fgColor=LIGHT)
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for cc, fmt in ((2, FMTINT), (3, FMT2)):
        ws1.cell(row=34, column=cc).number_format = fmt
    cf_exact(ws1, "A", 31, 33, {"有效动素": (GREEN_BG, GREEN_FG),
                                "辅助动素": (YELLOW_BG, YELLOW_FG),
                                "无效动素": (RED_BG, RED_FG)})

    # ── 五、改善措施统计（按实施批次，联动评审确认区）──
    section(ws1, 36, "五、改善措施统计（按实施批次，联动评审确认区）", n)
    for j, v in enumerate(["实施批次", "拟定条数", "已采纳(适用)条数", "说明", "", ""], start=1):
        ws1.cell(row=37, column=j, value=v)
    ws1.merge_cells("D37:F37")
    header(ws1, 37, n)
    batch_notes = d.get("batch_notes", {})
    for i, b in enumerate(batches, start=38):
        ws1.cell(row=i, column=1, value=b)
        put(ws1, f"B{i}", f"=COUNTIF({s3}!$J${dstart}:$J${l3},A{i})", batch_n.get(b, 0))
        put(ws1, f"C{i}", f'=COUNTIFS({s3}!$J${dstart}:$J${l3},A{i},{s3}!$M${dstart}:$M${l3},"适用")', 0)
        ws1.merge_cells(start_row=i, start_column=4, end_row=i, end_column=6)
        ws1.cell(row=i, column=4, value=batch_notes.get(b, ""))
        data_style(ws1, i, n, wrap=(4,), center=(2, 3))
        for cc in (2, 3):
            ws1.cell(row=i, column=cc).number_format = FMTINT
            ws1.cell(row=i, column=cc).fill = PatternFill("solid", fgColor=CALC)
        fit_row(ws1, i, {4: 58}, minh=22)
    tr = 38 + len(batches)
    ws1.cell(row=tr, column=1, value="合计")
    put(ws1, f"B{tr}", f"=SUM(B38:B{tr - 1})", len(measures))
    put(ws1, f"C{tr}", f"=SUM(C38:C{tr - 1})", 0)
    for cc in range(1, 4):
        cell = ws1.cell(row=tr, column=cc)
        cell.font, cell.border = BOLD, BORDER
        cell.fill = PatternFill("solid", fgColor=LIGHT)
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for cc in (2, 3):
        ws1.cell(row=tr, column=cc).number_format = FMTINT

    # ── 六、分析测算参考（未经评审确认，不得作为最终结果）──
    section(ws1, 44, "六、分析测算参考（未经评审确认，不得作为最终结果）", n)
    for j, v in enumerate(["指标", "测算值", "计算口径", "说明", "", ""], start=1):
        ws1.cell(row=45, column=j, value=v)
    ws1.merge_cells("D45:F45")
    header(ws1, 45, n)
    rows3 = [
        ("测算可优化合计(秒)", f"={s2}!$I${tot}", save_total, FMT2,
         "明细「测算可优化(秒)」合计",
         "分析侧测算（A/B/C时序折算＋检测≤10%封顶），仅供评审填N列时参考"),
        ("测算改善后CT(秒)", '=IF(OR($B$6="",$B$6=0),"",$B$6-$B$46)', ct_after_calc, FMT2,
         "现状CT - 测算可优化合计", d.get("ct_note", "测算参考；最终以评审确认结果为准")),
        ("测算一致性校验", f'=IF(ABS($B$46-{s3}!$L${t3})<0.005,"一致","不一致")', "一致", None,
         "明细测算合计 vs 措施清单「测算参考」合计",
         "两者须一致（生成时已交叉校验）；显示「不一致」说明数据被单侧修改"),
    ]
    for i, (label, formula, cached, fmt, cal, note) in enumerate(rows3, start=46):
        ws1.cell(row=i, column=1, value=label)
        put(ws1, f"B{i}", formula, cached)
        ws1.cell(row=i, column=3, value=cal)
        ws1.merge_cells(start_row=i, start_column=4, end_row=i, end_column=6)
        ws1.cell(row=i, column=4, value=note)
        data_style(ws1, i, n, wrap=(3, 4), center=(2,))
        if fmt:
            ws1.cell(row=i, column=2).number_format = fmt
        ws1.cell(row=i, column=2).fill = PatternFill("solid", fgColor=CALC)
        fit_row(ws1, i, {1: 24, 3: 24, 4: 56}, minh=22)
    ws1.merge_cells(start_row=49, start_column=1, end_row=49, end_column=6)
    c = ws1.cell(row=49, column=1,
                 value="口径：本区块数值来自「动素增值分析」测算列与「改善措施清单」测算参考列，均未经评审确认；"
                       "对外引用的改善结果一律以「二、评审确认结果」为准。")
    c.font, c.border = NOTE_FONT, BORDER
    c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=1)
    c.fill = PatternFill("solid", fgColor=CALC)
    fit_row(ws1, 49, {1: 122}, minh=22, line=13.0)

    # ── 七、关键结论与前提 ──
    cr = 51
    section(ws1, cr, "七、关键结论与前提", n)
    for i, txt in enumerate(d.get("conclusions", []), start=cr + 1):
        ws1.merge_cells(start_row=i, start_column=1, end_row=i, end_column=n)
        cell = ws1.cell(row=i, column=1, value=txt)
        cell.font, cell.border = NOTE_FONT, BORDER
        cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=1)
        cell.fill = PatternFill("solid", fgColor=ZEBRA if i % 2 == 0 else WHITE)
        fit_row(ws1, i, {1: 122}, minh=22, line=13.0)

    widths(ws1, {"A": 26, "B": 13, "C": 26, "D": 22, "E": 16, "F": 22})
    ws1.freeze_panes = "A5"
    chart = BarChart()
    chart.type, chart.style = "col", 10
    chart.title = "三类动素时间构成(秒)"
    chart.roundedCorners = False
    chart.y_axis.title, chart.x_axis.title = "秒", "动素类别"
    chart.y_axis.delete, chart.x_axis.delete = False, False
    if chart.legend is not None:
        chart.legend.overlay = False
    chart.height, chart.width = 8, 15
    chart.add_data(Reference(ws1, min_col=4, min_row=23, max_row=26), titles_from_data=True)
    chart.set_categories(Reference(ws1, min_col=1, min_row=24, max_row=26))
    chart.series[0].graphicalProperties.solidFill = "4472C4"
    ws1.add_chart(chart, "H4")
    print_setup(ws1, title_rows="1:2")

    for sheet, color in [(ws1, NAVY), (ws2, PRIMARY), (ws4, LIGHT), (ws3, PRIMARY), (ws7, LIGHT)]:
        sheet.sheet_properties.tabColor = color

    out = d["output"]
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    try:
        wb.save(out)
    except PermissionError:
        alt = out.replace(".xlsx", "_公式联动版.xlsx")
        wb.save(alt)
        out = alt
    injected = inject_cache(out)
    return out, injected, {
        "total_ct": total_ct, "save_total": save_total, "ct_after_calc": ct_after_calc,
        "cat_n": cat_n, "cat_t": cat_t, "cat_p": cat_p,
        "measures": len(measures), "batch_n": batch_n, "measure_ref": measure_ref,
    }


def main():
    # Windows 控制台默认 cp1252/cp936，打印中文路径会崩；统一安全输出
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    if len(sys.argv) != 2:
        print("Usage: python build_checklist.py <data.json>", file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
    out, injected, stat = build(data)
    print("SAVED:", out)
    print("SHEETS: 汇总指标, 动素增值分析, 5W2H提问, 改善措施清单, 口径与说明")
    print("CACHE_INJECTED:", injected, "/", len(CACHE))
    print("STATS:", json.dumps(stat, ensure_ascii=False))


if __name__ == "__main__":
    main()
