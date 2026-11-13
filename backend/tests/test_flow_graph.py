"""节点图（backend/app/services/flow_graph.py）。

分两层验：
  * 纯函数（match_edge / pick_next / entry_node / node_body）——不碰数据库
  * 与 flow_engine.step 的协作——有图按图走，没图完全走原有分支
"""

from __future__ import annotations

from app.services import flow_engine as fe
from app.services import flow_graph as fg


# ── match_edge ────────────────────────────────────────────────────────────

def test_always_edge_always_matches() -> None:
    assert fg.match_edge({"condition_type": "always"}, "", {}) is True
    assert fg.match_edge({"condition_type": "always", "condition_value": "x"}, "any", {}) is True


def test_keyword_edge_matches_any_listed_word() -> None:
    edge = {"condition_type": "keyword", "condition_value": "面试,可以,行"}
    assert fg.match_edge(edge, "那我明天可以过去", {}) is True
    assert fg.match_edge(edge, "面试时间是几点", {}) is True
    assert fg.match_edge(edge, "我再想想", {}) is False


def test_keyword_edge_ignores_blank_entries() -> None:
    # 运营手滑写了「,,可以,」这种，不能把空串当关键词（空串 in 任何文本都真）
    edge = {"condition_type": "keyword", "condition_value": ",,可以,"}
    assert fg.match_edge(edge, "我再想想", {}) is False
    assert fg.match_edge(edge, "可以", {}) is True


def test_regex_edge_and_bad_regex_fails_safe() -> None:
    assert fg.match_edge({"condition_type": "regex", "condition_value": r"\d{11}"}, "13800138000", {}) is True
    assert fg.match_edge({"condition_type": "regex", "condition_value": r"\d{11}"}, "没有号码", {}) is False
    # 正则写错不能抛异常，当不命中
    assert fg.match_edge({"condition_type": "regex", "condition_value": "([unclosed"}, "任意", {}) is False


def test_collected_edge_checks_slot_presence() -> None:
    edge = {"condition_type": "collected", "condition_value": "phone"}
    assert fg.match_edge(edge, "", {"phone": "13800138000"}) is True
    assert fg.match_edge(edge, "", {"phone": ""}) is False
    assert fg.match_edge(edge, "", {}) is False


def test_unknown_condition_type_does_not_match() -> None:
    assert fg.match_edge({"condition_type": "whatever", "condition_value": "x"}, "x", {}) is False


# ── pick_next ─────────────────────────────────────────────────────────────

EDGES = [
    {"from_node": "ask_interview", "to_node": "done", "condition_type": "keyword",
     "condition_value": "不去,算了", "priority": 5},
    {"from_node": "ask_interview", "to_node": "collect", "condition_type": "keyword",
     "condition_value": "可以,行", "priority": 10},
    {"from_node": "ask_city", "to_node": "send_info", "condition_type": "always",
     "condition_value": "", "priority": 100},
]


def test_pick_next_respects_priority() -> None:
    # 「不去」和「可以」都命中时 priority 小的（拒绝）先赢，
    # 与引擎里「拒绝优先」的既有规则一致
    assert fg.pick_next(EDGES, "ask_interview", "不去，我不去了", {}) == "done"
    assert fg.pick_next(EDGES, "ask_interview", "可以，明天到", {}) == "collect"


def test_pick_next_returns_none_when_nothing_matches() -> None:
    assert fg.pick_next(EDGES, "ask_interview", "我再考虑考虑", {}) is None
    assert fg.pick_next(EDGES, "no_such_node", "any", {}) is None


def test_pick_next_ignores_edges_from_other_nodes() -> None:
    assert fg.pick_next(EDGES, "ask_city", "随便说", {}) == "send_info"


# ── entry_node / node_body ────────────────────────────────────────────────

NODES = [
    {"node_key": "ask_city", "is_entry": 1, "body": "", "sort_order": 1},
    {"node_key": "send_info", "is_entry": 0, "body": "厂名：{{factory}}", "sort_order": 2},
]


def test_entry_node_picks_the_entry() -> None:
    assert fg.entry_node(NODES) == "ask_city"
    assert fg.entry_node([{"node_key": "x", "is_entry": 0}]) is None


def test_entry_node_takes_lowest_sort_order_when_multiple() -> None:
    nodes = [
        {"node_key": "b", "is_entry": 1, "sort_order": 9},
        {"node_key": "a", "is_entry": 1, "sort_order": 2},
    ]
    assert fg.entry_node(nodes) == "a"


def test_node_body_returns_configured_text_or_empty() -> None:
    assert fg.node_body(NODES, "send_info") == "厂名：{{factory}}"
    assert fg.node_body(NODES, "ask_city") == ""
    assert fg.node_body(NODES, "missing") == ""


# ── 与 flow_engine 的协作 ─────────────────────────────────────────────────

def test_no_graph_keeps_legacy_behaviour() -> None:
    """不传 graph 时，step() 走的仍是改造前的分支。"""
    state = fe.new_state()
    result = fe.step(state, "你好")
    assert result.stage == fe.STAGE_ASK_CITY
    assert "城市" in result.reply


def test_empty_graph_also_keeps_legacy_behaviour() -> None:
    """空图（没跑迁移 / 设备没配板块）同样回退到旧分支，不能卡住。"""
    state = fe.new_state()
    result = fe.step(state, "你好", graph={"nodes": [], "edges": [], "entry": None})
    assert result.stage == fe.STAGE_ASK_CITY


def test_graph_routes_from_ask_city_to_send_info() -> None:
    """有图时按边走：ask_city --always--> send_info。"""
    fe.set_remote_jobs({"广州": [{
        "factory_name": "利口福食品厂", "job_title": "利口福食品厂 普工",
        "wage_text": "16 元/小时", "hours_text": "两班倒",
        "welfare_text": "包吃包住", "place": "番禺南村",
    }]})
    try:
        graph = {
            "nodes": [
                {"node_key": "ask_city", "is_entry": 1, "body": ""},
                {"node_key": "send_info", "is_entry": 0, "body": ""},
            ],
            "edges": [
                {"from_node": "ask_city", "to_node": "send_info",
                 "condition_type": "always", "condition_value": "", "priority": 100},
            ],
            "entry": "ask_city",
        }
        state = fe.new_state()
        state["slots"]["city"] = "广州"
        result = fe.step(state, "广州", graph=graph)
        assert state["node"] == "send_info"
        assert "16 元/小时" in result.reply
    finally:
        fe.set_remote_jobs({})


def test_graph_custom_node_body_is_used() -> None:
    """节点上配了正文就发正文（运营自己加的节点）。"""
    graph = {
        "nodes": [
            {"node_key": "ask_city", "is_entry": 1, "body": ""},
            {"node_key": "faq_pitch", "is_entry": 0, "body": "我们这边包吃包住，月休四天。"},
        ],
        "edges": [
            {"from_node": "ask_city", "to_node": "faq_pitch",
             "condition_type": "always", "condition_value": "", "priority": 100},
        ],
        "entry": "ask_city",
    }
    state = fe.new_state()
    result = fe.step(state, "你好", graph=graph)
    assert "包吃包住" in result.reply
    assert state["node"] == "faq_pitch"


def test_done_node_is_terminal_even_with_graph() -> None:
    """已结束的会话不能被节点图重新拉起。"""
    graph = {
        "nodes": [{"node_key": "ask_city", "is_entry": 1, "body": ""}],
        "edges": [{"from_node": "done", "to_node": "ask_city",
                   "condition_type": "always", "condition_value": "", "priority": 1}],
        "entry": "ask_city",
    }
    state = fe.new_state()
    state["stage"] = fe.STAGE_DONE
    result = fe.step(state, "你好", graph=graph)
    assert result.finished is True
    assert result.stage == fe.STAGE_DONE
