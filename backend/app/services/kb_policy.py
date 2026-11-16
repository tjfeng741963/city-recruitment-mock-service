"""共享知识库的厂规准入：字面政策必须有岗位/雇主归属。"""
from __future__ import annotations

import re
from collections.abc import Iterable

# 覆盖招聘条件的常见直说、同义说法和金额声明；不靠是否含阿拉伯数字判断。
_POLICY_WORDS = (
    "工价", "工资", "薪资", "月薪", "时薪", "日薪", "底薪", "待遇", "多少钱", "工钱",
    "体检", "查体", "健康证", "报销", "收费", "费用", "免费", "交钱", "花钱", "押金", "中介费",
    "纹身", "刺青", "花臂", "案底", "犯罪记录", "前科", "录用", "入职条件",
    "转正", "试用期", "正式工", "借支", "预支", "补贴", "返费", "扣钱", "扣款",
    "社保", "五险", "保险", "一金", "包吃", "包住", "吃住", "宿舍", "住宿", "伙食", "管饭",
    "班次", "白班", "夜班", "倒班", "加班", "月休", "休息几天", "工作内容", "干什么活",
    "年龄", "岁数", "几岁", "身高", "民族", "户籍", "招工要求", "招聘要求",
    "证件", "身份证", "面试要带", "面试带什么",
)
_MONEY = re.compile(r"(?:\d+(?:\.\d+)?\s*(?:元|块|/\s*(?:小时|天|月|班)))|[￥¥]")
_FIELD = re.compile(r"\{([^{}\n|]{1,40})(?:\|([^{}\n]{1,200}))?\}")
_PUNCTUATION = re.compile(r"[\s，,。.;；:：!！?？、]+")
# 仅允许说明字段名称的中性标签；「免费」「都能进」等不是标签。
_LABELS = (
    "这边工价是", "工价是", "工资待遇", "工资", "工价", "薪资", "待遇",
    "体检要求", "体检安排", "纹身要求", "转正规则", "社保说明", "借支规则",
    "住宿条件", "吃住条件", "年龄要求", "班次安排", "工作内容", "身高要求",
    "民族要求", "月休安排", "线路安排", "证件要求", "搬迁安排",
)


def policy_sensitive(*texts: str) -> bool:
    value = "\n".join(str(text or "") for text in texts)
    return any(word in value for word in _POLICY_WORDS) or bool(_MONEY.search(value))


def shared_answer_allowed(
    question: str,
    answer: str,
    *,
    keywords: Iterable[str] = (),
    media: Iterable[str] = (),
    fact_fields: Iterable[str] = (),
) -> bool:
    """普通通用内容保留；招聘政策只允许无兜底、无附加承诺的事实模板。

    fact_fields 由 FAQ 渲染器提供。旧知识库不具备同样的字段渲染流程，
    不传字段列表时不允许用模板绕过。媒体也能承载别厂政策，敏感共享问答禁带媒体。
    """
    fields = set(fact_fields)
    matches = list(_FIELD.finditer(answer or ""))
    sensitive = policy_sensitive(question, *keywords, answer)
    sensitive = sensitive or any(match.group(1) in fields for match in matches)
    if not sensitive:
        return True
    if not matches or list(media) or "【" in (answer or ""):
        return False
    if any(match.group(1) not in fields or match.group(2) is not None for match in matches):
        return False
    prose = _FIELD.sub("", answer)
    for label in _LABELS:
        prose = prose.replace(label, "")
    return not _PUNCTUATION.sub("", prose)
