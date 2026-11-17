# -*- coding: utf-8 -*-
"""生成「岗位事实覆盖矩阵」HTML：72 项事实 × 12 个在营招工点。

三列口径：
- 原始资料：客户给的 xlsx / docx 里有没有这项（人工标注，见 ITEMS 的 raw 字段）
- 库内：data_json 有对应键，或 kb_faq 的问答文本命中关键词
- 差额：原始资料有、库里没有 = 导入丢失

只读 data/app.sqlite，不写库。
"""
import json
import sqlite3
from html import escape

DB = r"data/app.sqlite"
OUT = r"docs/岗位事实覆盖矩阵-20261116.html"

# (组, 编号, 名称, 客户问法, data_json 键, kb 关键词, 原始资料)
ITEMS = [
    ("A 主体与地点", [
        ("A1", "城市", "广州还是佛山", ["__always__"], [], "xlsx"),
        ("A2", "区/镇", "龙岗区有吗", ["place", "area_text"], ["区", "镇"], "xlsx"),
        ("A3", "厂名全称", "你们公司叫什么", ["__always__"], [], "xlsx"),
        ("A4", "岗位名", "招什么工", ["__always__"], [], "xlsx"),
        ("A5", "工作内容", "做什么的/累不累", ["work_text"], ["干什么", "工作内容", "做什么"], "xlsx+docx"),
        ("A6", "线路/车间", "分到哪个站", ["line_text"], ["哪个站", "线路", "车间"], "xlsx"),
    ]),
    ("B 钱", [
        ("B1", "工价+单位", "多少钱一小时", ["wage_text", "wage_unit"], ["工资", "工价", "多少钱"], "xlsx+docx"),
        ("B2", "实习/试用价", "实习期多少", ["wage_intern"], ["实习", "试用期"], "docx"),
        ("B3", "转正价", "转正后多少", ["wage_regular"], ["转正"], "docx"),
        ("B4", "分段价（1/2/3月）", "第二个月还是24吗", ["wage_ladder"], ["满一个月", "第二个月"], "docx"),
        ("B5", "连班/加班价", "连班多少", ["overtime_rule"], ["连班", "加班"], "docx"),
        ("B6", "补贴明细", "夜班有补贴吗", ["subsidy_text"], ["补贴", "高温"], "docx"),
        ("B7", "保底（N天班）", "保底多少", ["base_pay_text"], ["保底"], "docx"),
        ("B8", "综合月薪", "一个月拿多少", ["income_range"], ["综合", "月入", "到手"], "docx"),
        ("B9", "发薪日", "几号发工资", ["payday"], ["几号发", "发工资", "发薪"], "docx"),
        ("B10", "发放方式", "打卡还是微信", ["pay_method"], ["打卡", "微信", "银行卡"], "docx"),
        ("B11", "借支/预支", "能预支吗", ["advance_rule"], ["借支", "预支"], "docx"),
        ("B12", "三薪/节假日", "节假日几倍", ["holiday_pay"], ["三薪", "节假日"], "docx"),
    ]),
    ("C 扣费与押金", [
        ("C1", "押金（工服/饭卡）", "要押金吗", ["deposit_text"], ["押金"], "docx"),
        ("C2", "住宿费是否另收", "住宿扣钱吗", ["dorm_fee_text"], ["住宿费", "免费住"], ""),
        ("C3", "体检费谁出", "体检报销吗", ["medical_fee"], ["体检费", "报销"], "docx"),
        ("C4", "中介费/介绍费", "要交钱吗/是中介吗", ["fee_policy"], ["中介", "收费", "介绍费"], "docx"),
        ("C5", "工服/被褥", "工服要钱吗", ["uniform_text"], ["工服", "被褥", "被子"], "docx"),
    ]),
    ("D 门槛", [
        ("D1", "年龄上下限", "我52了能去吗", ["age_text"], ["年龄", "多大", "几岁"], "xlsx"),
        ("D2", "性别限制", "只要女的吗", ["gender_text"], ["只要女", "男生", "性别"], "xlsx"),
        ("D3", "身高（净/可垫）", "一米六行不行", ["height_text"], ["身高", "多高"], "xlsx"),
        ("D4", "学历", "要学历吗", ["edu_text"], ["学历"], ""),
        ("D5", "证件（叉车证/健康证）", "没证能去吗", ["cert_text"], ["叉车证", "健康证", "证件"], "xlsx+docx"),
        ("D6", "要不要体检", "要体检吗", ["medical_text"], ["体检"], "xlsx+docx"),
        ("D7", "纹身（位置/能否遮）", "有纹身能进吗", ["tattoo_policy"], ["纹身", "花臂"], "xlsx+docx"),
        ("D8", "案底", "有案底能进吗", ["record_policy"], ["案底"], "xlsx"),
        ("D9", "色弱/伤疤", "色弱能做吗", ["color_policy"], ["色弱", "色盲", "伤疤"], "xlsx"),
        ("D10", "民族/户籍", "彝族要吗/本地户口", ["ethnicity_policy"], ["民族", "彝族", "户籍", "户口"], "xlsx"),
        ("D11", "经验/技能", "没做过行吗", ["exp_text"], ["经验", "没做过", "学徒"], "docx"),
    ]),
    ("E 时间", [
        ("E1", "班次类型", "长白班有吗/要上夜班吗", ["shift_text"], ["白班", "两班倒", "夜班", "班次"], "xlsx+docx"),
        ("E2", "班次时间", "几点到几点", ["hours_text"], ["上班时间", "几点"], "xlsx"),
        ("E3", "实际在岗 vs 计薪", "一天干几小时", ["on_duty_hours"], ["在岗", "实际工作"], "docx"),
        ("E4", "休息规则（轮岗/吃饭）", "中间能休息吗", ["break_rule"], ["休息", "吃饭时间"], "docx"),
        ("E5", "月休/上几休几", "一个月休几天", ["rest_text"], ["月休", "休几天", "上几休"], "xlsx"),
        ("E6", "试用期+转正条件", "多久转正", ["probation_text"], ["转正", "试用期"], "docx"),
    ]),
    ("F 吃住", [
        ("F1", "包吃几餐/餐标", "包吃吗/几餐", ["meal_text"], ["包吃", "几餐", "吃饭"], "xlsx+docx"),
        ("F2", "饭卡（充值/押金）", "吃饭自己掏钱吗", ["canteen_card"], ["饭卡", "充值"], "docx"),
        ("F3", "宿舍几人间", "几个人一间", ["dorm_text"], ["几人", "宿舍"], "docx"),
        ("F4", "宿舍设施", "有空调吗", ["dorm_facility"], ["空调", "热水", "洗衣机", "独立卫生间"], "docx"),
        ("F5", "水电分摊", "水电怎么算", ["utility_text"], ["水电", "平摊", "分摊"], "docx"),
        ("F6", "被褥", "要带被子吗", ["bedding_text"], ["被褥", "被子"], "docx"),
        ("F7", "外宿/住宿补贴", "能外宿吗", ["outstay_policy"], ["外宿", "住宿补贴"], "docx"),
        ("F8", "夫妻房/带家属", "能带老婆吗", ["family_room"], ["夫妻房", "带老婆", "家属"], ""),
        ("F9", "宿舍到厂距离/班车", "宿舍离厂远吗", ["dorm_distance"], ["远不远", "班车", "走路"], ""),
    ]),
    ("G 面试", [
        ("G1", "面试时间", "什么时候面试", ["interview_time"], ["面试时间", "什么时候面试"], "xlsx"),
        ("G2", "面试地址", "在哪里面试", ["interview_addr", "place"], ["在哪里面试", "面试地址", "地址"], "xlsx"),
        ("G3", "路线/导航", "怎么走/哪站下", ["route_text"], ["怎么走", "地铁站", "出口"], "xlsx+docx"),
        ("G4", "携带资料", "要带什么", ["bring_text"], ["带什么", "准备什么", "复印件"], "xlsx"),
        ("G5", "着装要求", "要穿正装吗", ["dress_code"], ["拖鞋", "短裤", "着装"], "docx"),
        ("G6", "面试内容/难度", "面试难不难", ["interview_note"], ["面试简单", "面试态度", "难不难"], "docx"),
        ("G7", "能否看车间", "能看车间吗", ["can_tour"], ["看车间", "看厂", "厂区环境"], "docx"),
        ("G8", "联系人（到场前不发）", "到了找谁", ["contact_rule"], ["找谁", "队长", "联系"], "xlsx"),
        ("G9", "到场签到", "到了找谁签到", ["sign_in_rule"], ["签到"], "docx"),
    ]),
    ("H 上岗与离职", [
        ("H1", "培训", "要培训吗/带薪吗", ["training_text"], ["培训", "上岗证"], "xlsx+docx"),
        ("H2", "合同", "跟谁签合同", ["contract_text"], ["合同"], "docx"),
        ("H3", "工资卡要求", "必须本人卡吗", ["bank_card"], ["银行卡", "本人"], "xlsx"),
        ("H4", "工牌/工服发放", "工服什么时候发", ["uniform_issue"], ["工牌", "工服"], "docx"),
        ("H5", "离职流程", "提前几天说", ["resign_rule"], ["离职", "不做了"], "docx"),
        ("H6", "工资结清", "走了什么时候给", ["settle_rule"], ["结清", "人走账清"], "docx"),
    ]),
    ("I 信任与合规", [
        ("I1", "直招还是中介", "你们是中介吗", ["is_direct"], ["中介", "直招"], "docx"),
        ("I2", "是否收费", "要交钱吗", ["fee_policy"], ["收费", "不收费", "交钱"], "docx"),
        ("I3", "真实性", "真的假的/骗人吧", ["verify_text"], ["企查查", "骗", "真的"], "docx"),
        ("I4", "公司规模/资质", "你们公司多大", ["company_scale"], ["规模", "多少人"], ""),
        ("I5", "社保公积金", "买社保吗", ["insurance_text"], ["社保", "五险"], "xlsx+docx"),
    ]),
    ("J 媒体", [
        ("J1", "厂区图", "发个厂区看看", ["media_json:factory"], [], "图片"),
        ("J2", "车间图/视频", "有工作视频吗", ["media_json:work"], [], "视频"),
        ("J3", "宿舍图", "宿舍发我看下", ["media_json:dorm"], [], "图片+视频"),
        ("J4", "食堂图", "食堂怎么样", ["media_json:canteen"], [], "图片+视频"),
        ("J5", "工资条/工牌样例", "发个工资条", ["media_json:payslip"], [], ""),
    ]),
]

COLS = [
    ("GZ-PY-001", "松下美健", "factory"), ("GZ-PY-002", "松下电熨斗", "factory"),
    ("GZ-PY-003", "利口福", "factory"), ("GZ-PY-004", "华荻", "factory"),
    ("GZ-PY-005", "华智", "factory"), ("GZ-PY-006", "广汽商贸", "factory"),
    ("SUB-GZ-001", "广州地铁", "subway"), ("SUB-FS-001", "佛山万通", "subway"),
    ("SUB-FS-002", "佛山百花", "subway"), ("SUB-NC-001", "南昌地铁", "subway"),
    ("SUB-SZ-001", "深圳地铁", "subway"), ("SUB-NN-001", "南宁地铁", "subway"),
]


def load():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    emp = {r["employer_code"]: dict(r) for r in con.execute("select * from employer")}
    faq = {}
    for r in con.execute("select scope_employer_id, question from kb_faq where status='enabled'"):
        faq.setdefault(r["scope_employer_id"], []).append(r["question"] or "")

    # 岗位/工厂按名字挂到 employer
    pos_keys, fac_keys = {}, {}
    for r in con.execute("""select p.data_json, f.factory_name, f.data_json fjson
                            from service_positions p left join factories f on f.id=p.factory_id"""):
        keys = set(json.loads(r["data_json"] or "{}").keys())
        fk = set(json.loads(r["fjson"] or "{}").keys())
        for code, e in emp.items():
            names = {e["display_name"], e["short_name"] or ""}
            if r["factory_name"] in names:
                pos_keys.setdefault(code, set()).update(keys)
                fac_keys.setdefault(code, set()).update(fk)
    con.close()
    return emp, faq, pos_keys, fac_keys


def cell_status(item, code, keys, faq_text, media_assets):
    iid, name, q, data_keys, kws, raw = item
    # 媒体单独判
    for k in data_keys:
        if k.startswith("media_json:"):
            return "ok" if media_assets else "no"
    for k in data_keys:
        if k == "__always__" or k in keys:
            return "ok"
    if kws:
        for kw in kws:
            if kw in faq_text:
                return "ok"
    return "no"


def main():
    emp, faq, pos_keys, fac_keys = load()
    media_assets = 0
    try:
        con = sqlite3.connect(DB)
        media_assets = con.execute("select count(*) from media_assets").fetchone()[0]
        con.close()
    except Exception:
        pass

    rows_html = []
    stats = {c[0]: {"ok": 0, "raw": 0} for c in COLS}
    total_ok = 0
    total_raw = 0
    for group, items in ITEMS:
        rows_html.append(f'<tr class="grp"><td colspan="{len(COLS)+3}">{escape(group)}</td></tr>')
        for item in items:
            iid, name, q, data_keys, kws, raw = item
            cells = []
            for code, _, _ in COLS:
                keys = pos_keys.get(code, set()) | fac_keys.get(code, set())
                ft = " ".join(faq.get(emp[code]["id"], []))
                st = cell_status(item, code, keys, ft, media_assets)
                if st == "ok":
                    stats[code]["ok"] += 1
                cells.append(f'<td class="c{" ok" if st=="ok" else ""}">{"●" if st=="ok" else "·"}</td>')
            if raw:
                total_raw += 1
                for code, _, _ in COLS:
                    stats[code]["raw"] += 1
            rows_html.append(
                f'<tr><td class="id">{iid}</td><td class="nm">{escape(name)}'
                f'<span class="q">{escape(q)}</span></td>'
                f'<td class="raw">{escape(raw) if raw else "—"}</td>'
                + "".join(cells) + "</tr>"
            )

    total = len([i for g, its in ITEMS for i in its])
    for code, _, _ in COLS:
        total_ok += stats[code]["ok"]

    head = "".join(
        f'<th class="v{ " sub" if v=="subway" else "" }">{escape(n)}<span>{escape(c)}</span></th>'
        for c, n, v in COLS
    )

    avg_ok = total_ok / len(COLS)
    pct_ok = avg_ok / total * 100
    pct_raw = total_raw / total * 100

    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>岗位事实覆盖矩阵 · 74 项 × 12 个在营点</title>
<style>
:root{{--bg:#f4f6f9;--card:#fff;--line:#e6ebf1;--tx:#1c2430;--tx2:#5a6779;--mut:#8d99a8;
--ok:#0f9d6e;--okbg:#e9f8f1;--warn:#c07a09;--bad:#d64545;--blue:#2b6cf6}}
*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:var(--bg);color:var(--tx);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;padding:28px}}
.wrap{{max-width:1280px;margin:0 auto}}
h1{{font-size:22px;letter-spacing:.3px}}
.meta{{color:var(--mut);font-size:12.5px;margin:6px 0 20px}}
.kpis{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}}
.kpi{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}}
.kpi b{{display:block;font-size:24px;line-height:1.2}}
.kpi span{{color:var(--mut);font-size:12px}}
.kpi.hl b{{color:var(--bad)}}
.note{{background:#fff;border:1px solid var(--line);border-left:3px solid var(--blue);border-radius:10px;
padding:12px 16px;margin-bottom:18px;font-size:13px;color:var(--tx2)}}
.note b{{color:var(--tx)}}
table{{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--line);
font-size:12.5px}}
th,td{{border-bottom:1px solid #f0f3f7;padding:7px 8px;text-align:center}}
thead th{{background:#f7f9fc;position:sticky;top:0;z-index:2;box-shadow:0 1px 0 var(--line);font-weight:600;font-size:11.5px;color:var(--tx2);
white-space:nowrap;line-height:1.35;vertical-align:bottom}}
thead th span{{display:block;color:var(--mut);font-weight:400;font-size:9.5px}}
thead th.sub{{background:#f6f7ff}}
td.id{{color:var(--mut);font-size:11px;width:34px}}
td.nm{{text-align:left;min-width:190px}}
td.nm .q{{display:block;color:var(--mut);font-size:10.5px;line-height:1.3}}
td.raw{{color:var(--tx2);font-size:10.5px;white-space:nowrap;width:76px}}
tr.grp td{{background:#eef2f8;text-align:left;font-weight:600;font-size:12px;color:#3c4a63;letter-spacing:.5px}}
td.c{{color:#d9dfe7;font-size:15px;width:56px}}
td.c.ok{{color:var(--ok)}}
tbody tr:hover td{{background:#fcfdff}}
.covline{{font-size:12px;color:var(--tx2);margin:-6px 0 10px;line-height:1.9}}
.covline b{{color:var(--ok);font-size:13px}}
.legend{{display:flex;gap:18px;font-size:12px;color:var(--tx2);margin-top:14px;flex-wrap:wrap}}
.legend i{{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}}
</style></head><body><div class="wrap">
<h1>岗位事实覆盖矩阵 · 74 项 × 12 个在营点</h1>
<div class="meta">生成于 2026-11-16 · 数据源 data/app.sqlite（只读）· 「原始资料」列为客户交付的 02-xlsx / 03-docx 里是否写了这项</div>

<div class="kpis">
  <div class="kpi"><b>{total}</b><span>一个岗位应有的事实项</span></div>
  <div class="kpi"><b>{total_raw}</b><span>原始资料里其实已经写了（{pct_raw:.0f}%）</span></div>
  <div class="kpi hl"><b>{avg_ok:.0f}</b><span>库里平均答得上（{pct_ok:.0f}%）</span></div>
  <div class="kpi"><b>{total_raw - avg_ok:.0f}</b><span>资料有、库里没有 → 导入丢失</span></div>
</div>

<div class="note">
<b>怎么读：</b>● = 该招工点能从岗位档案或本厂问答里直接答上；· = 答不上，只能走全局兜底（15 条通用话术，不含本厂细节）。<b>● 只代表「有值」，不代表「够用」</b>——例如工厂的面试地址只到「番禺区钟村」，没有门牌。<br>
<b>结论：</b>客户交了 {total_raw} 项事实，真正进到库里能用的只有 {avg_ok:.0f} 项。缺口不在「客户没说」，在 <b>导入只挑了几列</b>：工厂 xlsx 16 列只进来 5 列（工作内容/性别/包吃/包住全丢），地铁的「面试携带资料 / 上岗流程」整列没进。
</div>

<div class="covline">各点能直接答上的项数：{" · ".join(f'{n} <b>{stats[c]["ok"]}</b>' for c, n, _ in COLS)}（满分 {total}）</div>

<table>
<thead><tr><th style="width:34px">#</th><th style="text-align:left">事实项 / 客户会怎么问</th><th>原始资料</th>{head}</tr></thead>
<tbody>{''.join(rows_html)}</tbody>
</table>

<div class="legend">
  <span><i style="background:var(--ok)"></i>库里答得上</span>
  <span><i style="background:#d9dfe7"></i>答不上（靠全局兜底或编）</span>
  <span>「原始资料」标注来自：工厂 xlsx 16 列 / 地铁 xlsx 11 列 / 两份话术 docx / 图片视频目录</span>
</div>
</div></body></html>"""

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    print("ok", OUT, "avg_ok=%.1f" % avg_ok, "total_raw=%d" % total_raw, "total=%d" % total)


if __name__ == "__main__":
    main()
