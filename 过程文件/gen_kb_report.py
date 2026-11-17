# -*- coding: utf-8 -*-
"""一次性脚本：从 data/app.sqlite 生成「知识库盘点 · 工厂岗位维度」HTML 报告。
不改任何业务代码，不写库，只读。产物：docs/知识库盘点-工厂岗位维度-20261116.html
"""
import json
import html
import sqlite3
from collections import defaultdict

DB = "data/app.sqlite"
OUT = "docs/知识库盘点-工厂岗位维度-20261116.html"

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row

cities = {r["id"]: dict(r) for r in con.execute("SELECT * FROM cities")}
factories = [dict(r) for r in con.execute("SELECT * FROM factories ORDER BY id")]
positions = [dict(r) for r in con.execute("SELECT * FROM service_positions ORDER BY id")]
employers = [dict(r) for r in con.execute("SELECT * FROM employer ORDER BY employer_code")]
aliases = defaultdict(list)
for r in con.execute("SELECT * FROM employer_alias"):
    aliases[r["employer_id"]].append(r["alias"])
faqs = [dict(r) for r in con.execute(
    "SELECT * FROM kb_faq WHERE status='enabled' ORDER BY scope_employer_id, scope_position_id, priority DESC, id")]
templates = {r["vertical_code"]: dict(r) for r in con.execute("SELECT * FROM kb_template")}
template_items = defaultdict(list)
for r in con.execute("SELECT * FROM kb_template_item ORDER BY template_id, sort_order"):
    row = dict(r)
    row["keywords"] = json.loads(row["keywords"] or "[]")
    template_items[templates_key := next(c for c, v in templates.items() if v["id"] == row["template_id"])].append(row)
con.close()


def jparse(raw):
    try:
        d = json.loads(raw or "{}")
        return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def norm(s):
    return (s or "").lower().replace(" ", "").replace("·", "")


def match_employer(factory_name):
    """与前端 matchEmployer 同一套口径，但 LEGACY 重复档案只作兜底：
    LEGACY-F9..F14 与 SUB-GZ-001..NN-001 同名，且按 employer_code 排序排在前面，
    直接按前端顺序匹配会让地铁厂全部命中 LEGACY（FAQ 都挂在 SUB 上），统计全错。
    （前端 factory-overview.js 存在同样的现象——报告 findings 里如实记录，不改代码。）"""
    if not factory_name:
        return None
    key = norm(factory_name)
    pools = [[e for e in employers if not e["employer_code"].startswith("LEGACY")],
             [e for e in employers if e["employer_code"].startswith("LEGACY")]]
    for pool in pools:
        for e in pool:
            names = [e["display_name"], e["short_name"]] + aliases.get(e["id"], [])
            for n in names:
                if norm(n) and norm(n) == key:
                    return e
        for e in pool:
            for n in [e["short_name"], e["display_name"]]:
                n = norm(n)
                if len(n) >= 2 and (n in key or key in n):
                    return e
    return None


def bigrams(s):
    s = norm(s)
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) >= 2 else {s}


def topic_covered(topic, questions):
    """模板主题是否被现有问答覆盖：问题 bigram 重叠 >=2，或主题是某问题的子串。"""
    tb = bigrams(topic)
    for q in questions:
        if topic in norm(q):
            return True
        if len(tb & bigrams(q)) >= 2:
            return True
    return False


# FAQ 分桶
faq_global = defaultdict(list)      # vertical_id -> [faq]
faq_vertical = defaultdict(list)    # vertical_id -> [faq]
faq_employer = defaultdict(list)    # employer_id -> [faq]
faq_position = defaultdict(list)    # position_id -> [faq]
for f in faqs:
    lvl = f["scope_level"]
    if lvl == "global":
        faq_global[f["vertical_id"] or 0].append(f)
    elif lvl == "vertical":
        faq_vertical[f["vertical_id"] or 0].append(f)
    elif lvl == "employer" and f["scope_employer_id"]:
        faq_employer[f["scope_employer_id"]].append(f)
    elif lvl == "position" and f["scope_position_id"]:
        faq_position[f["scope_position_id"]].append(f)

esc = html.escape


def faq_rows(rows, placeholder_note=True):
    if not rows:
        return '<p class="empty">无</p>'
    out = ['<table class="faq"><thead><tr><th style="width:26%">问题</th><th>答案全文</th></tr></thead><tbody>']
    for f in rows:
        ans = f["answer"] or ""
        has_ph = "{" in ans and "}" in ans
        note = ' <span class="ph" title="答案里的大括号是发送时才替换的占位符（如 {wage} 会换成工价）">含占位符</span>' if has_ph and placeholder_note else ""
        out.append(f"<tr><td class='q'>{esc(f['question'])}</td><td>{esc(ans)}{note}</td></tr>")
    out.append("</tbody></table>")
    return "".join(out)


def coverage_block(vcode, local_questions, global_questions):
    """覆盖口径：只统计本厂（招工方 + 岗位级）直答覆盖；缺失的主题里再区分
    「全局有兜底」与「完全没人能答」。全局问答本身不算本厂覆盖。"""
    items = template_items.get(vcode, [])
    if not items:
        return ""
    local_ok, global_ok, none_ok = [], [], []
    for it in items:
        if topic_covered(it["question"], local_questions):
            local_ok.append(it["question"])
        elif topic_covered(it["question"], global_questions):
            global_ok.append(it["question"])
        else:
            none_ok.append(it["question"])
    parts = [f'<p class="cov-line">对照模板 <b>{esc(templates[vcode]["name"])}</b>（{len(items)} 个标准主题）：'
             f'<span class="ok">本厂直答 {len(local_ok)}</span> · '
             f'仅全局兜底 {len(global_ok)} · <span class="miss">完全缺失 {len(none_ok)}</span></p>']
    if global_ok:
        parts.append('<p class="cov-soft">仅靠全局兜底（答案是通用话术，没有本厂细节）：' + esc("、".join(global_ok)) + "</p>")
    if none_ok:
        parts.append('<p class="cov-miss">完全缺失：' + esc("、".join(none_ok)) + "</p>")
    return "".join(parts)


cards = []
stats = {"factory": 0, "subway": 0, "pos": 0, "employer_faq": 0}
orphan_employers = []
matched_ids = set()

for fac in factories:
    d = jparse(fac["data_json"])
    fac_positions = [p for p in positions if p["factory_id"] == fac["id"]]
    emp = match_employer(fac["factory_name"])
    vcode = "subway" if (emp and emp["vertical_id"] == 2) else "factory"
    vid = 2 if vcode == "subway" else 1
    stats[vcode] += 1
    stats["pos"] += len(fac_positions)
    if emp:
        matched_ids.add(emp["id"])
        stats["employer_faq"] += len(faq_employer.get(emp["id"], []))

    city = cities.get(fac["city_id"], {})
    city_name = city.get("city_name", f'#{fac["city_id"]}')

    # 覆盖统计：本厂直答 = 招工方 + 岗位级；全局兜底 = global + vertical 层
    local_questions = []
    if emp:
        local_questions += [f["question"] for f in faq_employer.get(emp["id"], [])]
    for p in fac_positions:
        local_questions += [f["question"] for f in faq_position.get(p["id"], [])]
    global_questions = ([f["question"] for f in faq_global.get(vid, [])]
                        + [f["question"] for f in faq_vertical.get(vid, [])])

    rows_html = []
    if fac_positions:
        rows_html.append("<h4>岗位与知识库 · 岗位级</h4>")
        for p in fac_positions:
            pd = jparse(p["data_json"])
            chips = []
            label_map = [("wage_text", "工价"), ("hours_text", "班次"), ("rest_text", "休息"),
                         ("age_text", "年龄"), ("height_text", "身高"), ("line_text", "线路"),
                         ("ethnicity_policy", "民族限制")]
            for k, lab in label_map:
                if pd.get(k):
                    chips.append(f"<span class='chip'><b>{lab}</b> {esc(str(pd[k]))}</span>")
            rows_html.append(
                f'<div class="pos"><p class="pos-name">{esc(p["position_name"])}'
                + ('<span class="off">已停用</span>' if p["status"] != "enabled" else "")
                + "</p><div class='chips'>" + "".join(chips) + "</div>"
                + faq_rows(faq_position.get(p["id"], [])) + "</div>")
    else:
        rows_html.append('<h4>岗位与知识库 · 岗位级</h4><p class="empty">没有岗位</p>')

    if emp:
        emp_block = (f"<h4>本厂专属问答 · 招工方「{esc(emp['short_name'] or emp['display_name'])}」"
                     f"（{esc(emp['employer_code'])}，{len(faq_employer.get(emp['id'], []))} 条）</h4>"
                     + faq_rows(faq_employer.get(emp["id"], [])))
    else:
        emp_block = "<h4>本厂专属问答</h4><p class='empty'>未匹配到招工方档案（厂名对不上 employer 表），只能靠全局问答兜底</p>"

    common = (f"<h4>品类通用问答 · {esc(templates[vcode]['name'])}"
              f"（global {len(faq_global.get(vid, []))} 条 + vertical {len(faq_vertical.get(vid, []))} 条）</h4>"
              + faq_rows(faq_vertical.get(vid, []))
              + faq_rows(faq_global.get(vid, [])))

    cards.append(f"""
<details class="card" {'open' if fac["id"] in (9,) else ''}>
<summary><span class="fac-name">{esc(fac["factory_name"])}</span>
<span class="tag {'t-subway' if vcode == 'subway' else ''}">{'地铁安检' if vcode == 'subway' else '工厂'}</span>
<span class="meta">{esc(city_name)} · {len(fac_positions)} 个岗位 · 招工方 {esc(emp['employer_code']) if emp else '未匹配'}</span></summary>
<div class="card-body">
<p class="fac-meta">面试地点：{esc(d.get('place', '—'))} ｜ 面试时间：{esc(d.get('interview_time', '—'))} ｜ 联系人：{esc(d.get('contact', '—'))}</p>
{"".join(rows_html)}
{emp_block}
<details class="inner"><summary>品类通用问答（点开看全文）</summary>{common}</details>
{coverage_block(vcode, local_questions, global_questions)}
</div></details>""")

# 有招工方档案但没有工厂/岗位的城市
for e in employers:
    if e["id"] in matched_ids or e["status"] != "enabled":
        continue
    if e["employer_code"].startswith("LEGACY"):
        continue
    v = 2 if e["vertical_id"] == 2 else 1
    orphan_employers.append(f"""
<details class="card"><summary><span class="fac-name">{esc(e["display_name"])}</span>
<span class="tag t-warn">缺工厂/岗位档案</span>
<span class="meta">{esc(e["employer_code"])} · 知识库 {len(faq_employer.get(e["id"], []))} 条</span></summary>
<div class="card-body">{faq_rows(faq_employer.get(e["id"], []))}</div></details>""")

total_faq = len(faqs)
html_doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>知识库盘点 · 工厂岗位维度（2026-11-16）</title>
<style>
*{{box-sizing:border-box}} body{{margin:0;background:#f5f7fa;color:#1f2d3d;font:14px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}}
.wrap{{max-width:1080px;margin:0 auto;padding:28px 20px 60px}}
h1{{font-size:22px;margin:0 0 4px}} .sub{{color:#7f8fa4;font-size:13px;margin:0 0 20px}}
.stat{{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:22px}}
.stat span{{background:#fff;border:1px solid #e4e9f0;border-radius:10px;padding:8px 16px;font-size:13px;color:#5a6b83}}
.stat b{{color:#1f2d3d;font-size:16px}}
.findings{{background:#fff;border:1px solid #e4e9f0;border-radius:14px;padding:16px 22px;margin-bottom:24px}}
.findings h2{{font-size:15px;margin:0 0 8px}} .findings li{{margin:4px 0;color:#3c4a63}}
.findings .bad{{color:#c0392b;font-weight:600}}
.card{{background:#fff;border:1px solid #e4e9f0;border-radius:14px;margin-bottom:12px;overflow:hidden}}
summary{{cursor:pointer;padding:13px 18px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;list-style:none}}
summary::-webkit-details-marker{{display:none}}
.fac-name{{font-weight:600;font-size:15px}}
.tag{{font-size:11px;border-radius:999px;padding:1px 10px;background:#e8f1fd;color:#2b6cb0}}
.tag.t-subway{{background:#e6f7ef;color:#1e9e6a}}
.tag.t-warn{{background:#fdf0ec;color:#d35400}}
.meta{{font-size:12px;color:#8a97a8;margin-left:auto}}
.card-body{{padding:4px 18px 16px;border-top:1px solid #eef2f6}}
h4{{font-size:13.5px;margin:14px 0 6px;color:#2c3e50}}
.pos{{margin:8px 0 14px;padding-left:10px;border-left:3px solid #dbe6f2}}
.pos-name{{font-weight:600;margin:6px 0 4px}}
.off{{font-size:11px;color:#c0392b;margin-left:8px}}
.chips{{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}}
.chip{{background:#f2f6fb;border-radius:8px;padding:2px 10px;font-size:12px;color:#4a5a75}}
.chip b{{color:#2c3e50}}
table.faq{{width:100%;border-collapse:collapse;font-size:13px}}
table.faq th{{text-align:left;color:#8a97a8;font-weight:500;padding:4px 8px;border-bottom:1px solid #e4e9f0}}
table.faq td{{padding:6px 8px;border-bottom:1px dashed #e8edf3;vertical-align:top}}
table.faq td.q{{color:#2b6cb0;font-weight:500;white-space:nowrap}}
.empty{{color:#9aa7b8;font-size:13px;margin:4px 0}}
details.inner{{margin:8px 0}} details.inner>summary{{padding:6px 0;font-size:13px;color:#2b6cb0}}
.cov-line{{margin:10px 0 4px;font-size:13px}} .cov-miss{{margin:0;font-size:12.5px;color:#c0392b}}
.cov-soft{{margin:0;font-size:12.5px;color:#b07d2b}}
.ok{{color:#1e9e6a;font-weight:600}} .miss{{color:#c0392b;font-weight:600}}
.ph{{font-size:11px;color:#b07d2b;background:#fdf6e9;border-radius:6px;padding:0 6px;margin-left:6px}}
h2.sec{{font-size:16px;margin:28px 0 12px;border-left:4px solid #2b6cb0;padding-left:10px}}
</style></head><body><div class="wrap">
<h1>知识库盘点 · 工厂岗位维度</h1>
<p class="sub">生成于 2026-11-16 16:55 · 数据源 data/app.sqlite（Fastify 主库，只读导出） · 覆盖 kb_faq 启用 {total_faq} 条</p>
<div class="stat">
<span>工厂 <b>{stats["factory"]}</b> 家</span><span>地铁安检点 <b>{stats["subway"]}</b> 个</span>
<span>岗位 <b>{stats["pos"]}</b> 个</span><span>已挂招工方问答 <b>{stats["employer_faq"]}</b> 条</span>
<span>全局通用问答 <b>{len(faq_global.get(1, [])) + len(faq_global.get(2, []))}</b> 条</span>
</div>
<div class="findings"><h2>详细度差距（为什么感觉不详细）</h2><ul>
<li class="bad">8 个地铁城市（杭州、成都、沈阳、昆明、青岛、武汉、郑州、重庆）只有 1 条占位问答，连工厂/岗位档案都没建——用户问任何具体问题都答不上来。</li>
<li class="bad">番禺 6 家工厂每家只有 5 条本厂问答 + 1 条岗位工价，对照 15 主题模板缺一大半：包吃住、宿舍几人间、多久转正、买社保、体检、纹身、借支、中介……多数靠全局兜底。</li>
<li>地铁已建的 6 个点（广州/佛山×2/南昌/深圳/南宁）覆盖较好：岗位级 + 招工方级各约 10 条，基本对齐 18 主题模板。</li>
<li>地铁岗位级和招工方级两套问答内容高度重复（同一内容存了两份），改工价要双改，容易改漏。</li>
<li>现有「工厂配置总览」页面按厂名匹配招工方时，LEGACY 重复档案排在前面，地铁厂会显示"本厂 0 条"——问答实际挂在 SUB-* 档案上，属于匹配口径问题（本次只整理，未改代码）。</li>
<li>全局问答里有不少答案只写了占位符（如 <code>{{tattoo_policy}}</code>、<code>{{dorm}}</code>），没有实际文字，等于没答。</li>
<li>话术表 position_scripts 是 0 条——五时点话术还没配，与知识库无关但同属"不详细"的感受来源。</li>
</ul></div>
<h2 class="sec">按工厂逐家盘点</h2>
{"".join(cards)}
<h2 class="sec">只有招工方档案、没建工厂/岗位的城市</h2>
{"".join(orphan_employers) or '<p class="empty">无</p>'}
<p class="sub" style="margin-top:24px">说明：答案里的大括号占位符（如 {{wage}}）是发送时由回复服务按岗位资料替换的；空白占位符表示该题当前等于没有答案。本报告为静态快照，数据改动后需重新生成。</p>
</div></body></html>"""

import os
os.makedirs("docs", exist_ok=True)
with open(OUT, "w", encoding="utf-8") as fh:
    fh.write(html_doc)
print("written", OUT, len(html_doc), "chars")
