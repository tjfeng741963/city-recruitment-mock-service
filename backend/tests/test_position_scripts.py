"""岗位级硬编码话术（config.position_scripts）：按 position_id + stage 命中。

契约（四端冻结）：
    position_scripts: [{position_id, stage, title, content, media}]
    stage ∈ greet / send_info / ask_interview / booked / unanswered
    content 含 {{factory}} {{wage}} … 与 【图片:名称】 媒体标记

命中规则：position_id + stage 精确 → 该 stage 任意岗位（第一个）→ 未命中走原逻辑。
命中后整段直发，模型的输出一律丢弃，但 stage/槽位仍按确定性规则推进。
"""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from app.services import device_scripts, job_lookup, kb_faq
from app.services.flow_engine import set_position_scripts, set_remote_jobs

JOBS = [
    {
        "position_id": 3,
        "factory_name": "观澜精密厂",
        "job_title": "观澜精密厂 质检",
        "wage_text": "23 元/小时",
        "hours_text": "两班倒，月休 4 天",
        "age_text": "18-40 岁",
        "welfare_text": "包吃包住",
        "place": "观澜大道 88 号",
    }
]

SEND_INFO_SCRIPT = {
    "position_id": 3,
    "stage": "send_info",
    "title": "观澜质检岗介绍",
    "content": (
        "{{factory}}在招{{job_title}}，工价{{wage}}，{{age_text}}，{{welfare}}。\n"
        "面试地点：{{place}}\n【图片:厂区大门.jpg】\n【视频:车间实拍.mp4】"
    ),
    "media": [
        {"name": "厂区大门.jpg", "kind": "image", "sha256": "aaa"},
        {"name": "车间实拍.mp4", "kind": "video", "sha256": "bbb"},
    ],
}


class ProviderProbe:
    """话术命中时模型一次都不许调。"""

    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, *args, **kwargs):  # noqa: ANN002, ANN003
        self.calls += 1
        raise RuntimeError("岗位话术命中时不该调模型")


@pytest.fixture(autouse=True)
def _isolate(monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setattr("app.api_flow.build_provider", lambda: None)
    monkeypatch.setenv("FLOW_PROFILE_TOKEN", "test-profile-token")
    job_lookup.clear_cache()
    device_scripts.clear_cache()
    set_remote_jobs({})
    set_position_scripts([])
    yield
    job_lookup.clear_cache()
    device_scripts.clear_cache()
    set_remote_jobs({})
    set_position_scripts([])


@pytest.fixture
def remote_jobs(monkeypatch):  # noqa: ANN001, ANN201
    """4222 岗位接口：返回带 position_id 的真实岗位。"""

    async def fake_fetch(city: str, token: str, url: str, device_code: str = "") -> list[dict]:
        return [dict(job) for job in JOBS]

    monkeypatch.setattr(job_lookup, "_fetch_items", fake_fetch)


def _stub_scripts(monkeypatch, scripts: list[dict]) -> None:  # noqa: ANN001
    """话术从 meta 里取（与 config 同一份缓存），这里直接替换取数入口。"""

    async def fake_position_scripts(device_code: str) -> list[dict]:
        return [dict(item) for item in scripts]

    monkeypatch.setattr("app.api_flow.fetch_position_scripts", fake_position_scripts)


async def _say(client: AsyncClient, key: str, text: str, **extra) -> dict:
    resp = await client.post(
        "/api/v1/flow/answer", json={"session_key": key, "text": text, **extra}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ── 匹配规则（纯函数）───────────────────────────────────────────────


def test_pick_position_script_exact_position() -> None:
    scripts = [
        {"position_id": 3, "stage": "send_info", "content": "三号岗"},
        {"position_id": 4, "stage": "send_info", "content": "四号岗"},
    ]
    hit = device_scripts.pick_position_script(scripts, 4, "send_info")
    assert hit is not None and hit["content"] == "四号岗"


def test_pick_position_script_never_borrows_other_positions() -> None:
    """没有精确匹配时只能落到通用条目（position_id=0），绝不借别的岗位。

    2026-11-14 实测事故：南昌岗位的话术被套给了广州客户，渲染时还用广州的
    岗位数据填占位符，客户收到「广州地铁安检在招安检员」+ 南昌的面试地点。
    """
    scripts = [
        {"position_id": 9, "stage": "send_info", "content": "九号岗"},
        {"position_id": 0, "stage": "send_info", "content": "通用"},
    ]
    # 精确命中
    assert device_scripts.pick_position_script(scripts, 9, "send_info")["content"] == "九号岗"
    # 没配的岗位 → 只用通用条目
    assert device_scripts.pick_position_script(scripts, 8, "send_info")["content"] == "通用"
    # 还不知道岗位（0）→ 只用通用条目
    assert device_scripts.pick_position_script(scripts, 0, "send_info")["content"] == "通用"
    # 没有通用条目时宁可返回 None（走 KB/模型），也不借别家岗位的文案
    only_other = [{"position_id": 9, "stage": "send_info", "content": "九号岗"}]
    assert device_scripts.pick_position_script(only_other, 8, "send_info") is None
    assert device_scripts.pick_position_script(only_other, 0, "send_info") is None


def test_pick_position_script_miss_returns_none() -> None:
    scripts = [{"position_id": 3, "stage": "greet", "content": "首句"}]
    assert device_scripts.pick_position_script(scripts, 3, "send_info") is None
    assert device_scripts.pick_position_script([], 3, "send_info") is None


def test_normalize_meta_keeps_position_scripts() -> None:
    meta = device_scripts._normalize_meta(
        {
            "position_scripts": [
                SEND_INFO_SCRIPT,
                {"stage": "send_info"},  # 没正文：丢掉，不能挡住回退
                "oops",
            ]
        }
    )
    scripts = meta["position_scripts"]
    assert len(scripts) == 1
    assert scripts[0]["position_id"] == 3
    assert scripts[0]["media"][0]["name"] == "厂区大门.jpg"
    # 每次返回的列表独立，不污染 EMPTY_META
    scripts.append({"stage": "x"})
    assert device_scripts.EMPTY_META["position_scripts"] == []


# ── send_info：话术命中即直发 ─────────────────────────────────────


async def test_send_info_uses_position_script_and_keeps_media(
    admin_client: AsyncClient, monkeypatch, remote_jobs  # noqa: ANN001
) -> None:
    _stub_scripts(monkeypatch, [SEND_INFO_SCRIPT])
    probe = ProviderProbe()
    monkeypatch.setattr("app.api_flow.build_provider", lambda: probe)

    key = f"pos-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    calls_before = probe.calls  # 问城市那一轮本来就是模型/兜底在答
    info = await _say(admin_client, key, "深圳")

    # 占位符全部换成岗位事实
    assert "观澜精密厂" in info["reply"] and "23 元/小时" in info["reply"]
    assert "18-40 岁" in info["reply"] and "包吃包住" in info["reply"]
    # 媒体标记原样保留（客户端据此发图），不被过滤/转义
    assert "【图片:厂区大门.jpg】" in info["reply"]
    assert "【视频:车间实拍.mp4】" in info["reply"]
    # 走的是话术，不是代码拼的卡片
    assert "厂名：" not in info["reply"]
    # 命中即不调模型（发岗位这一轮一次都没调）
    assert probe.calls == calls_before
    # 确定性推进：岗位 id 钉住 + 已发岗位卡
    assert info["stage"] == "ask_interview"
    assert info["slots"]["position_id"] == 3
    assert info["slots"]["interview_offer_sent"] is True


async def test_send_info_without_position_script_falls_back(
    admin_client: AsyncClient, monkeypatch, remote_jobs  # noqa: ANN001
) -> None:
    _stub_scripts(monkeypatch, [])

    key = f"pos-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    info = await _say(admin_client, key, "深圳")

    # 原逻辑：代码拼卡片（段1 含「厂名：」），不空回复
    assert "厂名：" in info["parts"][0] and "观澜精密厂" in info["parts"][0]
    assert any("这两天能不能过来面试" in part for part in info["parts"])
    # 岗位 id 仍被钉住（后续 KB/话术要用）
    assert info["slots"]["position_id"] == 3


async def test_ask_interview_script_used_on_retry(
    admin_client: AsyncClient, monkeypatch, remote_jobs  # noqa: ANN001
) -> None:
    scripts = [
        {"position_id": 3, "stage": "ask_interview", "content": "明天上午能过来看看吗？"}
    ]
    _stub_scripts(monkeypatch, scripts)

    key = f"pos-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "深圳")
    asked = await _say(admin_client, key, "我在忙")

    assert "明天上午能过来看看吗？" in asked["reply"]
    assert asked["stage"] == "ask_interview"


async def test_booked_script_used_after_booking(
    admin_client: AsyncClient, monkeypatch, remote_jobs  # noqa: ANN001
) -> None:
    scripts = [
        {
            "position_id": 3,
            "stage": "booked",
            "content": "约好了：{{factory}}，{{place}}见。",
        }
    ]
    _stub_scripts(monkeypatch, scripts)

    key = f"pos-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "深圳")
    await _say(admin_client, key, "可以")
    done = await _say(admin_client, key, "张三 13800138000")

    assert done["stage"] == "done"
    assert done["action"] == "book_interview"
    assert done["reply"].strip() == "约好了：观澜精密厂，观澜大道 88 号见。"


# ── greet：加好友首句 ────────────────────────────────────────────


def _stub_meta(monkeypatch, **meta) -> None:  # noqa: ANN001
    base = dict(device_scripts.EMPTY_META)
    base.update(meta)

    async def fake_meta(device_code: str) -> dict:
        return dict(base)

    monkeypatch.setattr("app.api_flow.fetch_device_meta", fake_meta)


async def test_greet_uses_greet_script(
    admin_client: AsyncClient, monkeypatch, remote_jobs  # noqa: ANN001
) -> None:
    _stub_meta(monkeypatch, vertical_code="factory", vertical_id=1, city="深圳")
    _stub_scripts(
        monkeypatch,
        [
            {
                "position_id": 0,
                "stage": "greet",
                "content": "哈喽，{{factory}}在招人，工价{{wage}}【图片:厂区大门.jpg】",
            }
        ],
    )

    body = (
        await admin_client.post(
            "/api/v1/flow/greet",
            json={"session_key": f"greet-{uuid.uuid4().hex[:8]}", "device_code": "pc-p-01"},
        )
    ).json()

    assert body["skipped"] is False
    # 新契约：配了 greet 话术就走「先问地点」，不发岗位卡、不置 interview_offer_sent
    assert body["stage"] == "ask_city"
    assert body["reply"] == "哈喽，观澜精密厂在招人，工价23 元/小时【图片:厂区大门.jpg】"
    assert "面试地点" not in body["reply"]


# ── 知识库硬过滤：position_id 生效 ────────────────────────────────


async def test_kb_lookup_receives_pinned_position_id(
    admin_client: AsyncClient, monkeypatch, remote_jobs  # noqa: ANN001
) -> None:
    _stub_scripts(monkeypatch, [])
    seen: list[dict] = []

    async def fake_lookup(session, question, **kwargs):  # noqa: ANN001, ANN002, ANN003
        seen.append(kwargs)
        return None

    monkeypatch.setattr(kb_faq, "lookup", fake_lookup)

    key = f"pos-{uuid.uuid4().hex[:8]}"
    await _say(admin_client, key, "你好")
    await _say(admin_client, key, "深圳")  # 发卡 → 钉住 position_id=3
    await _say(admin_client, key, "多少钱")

    assert seen, "ask_interview 阶段必须查知识库"
    assert seen[-1]["position_id"] == 3
