"""换企微账号后客户端必须重新解析账号目录（2026-11-17 线上实测回归）。

现场：云端 Windows 客户机换了企微账号（退登录 → 重新扫码），机器码没变。
企微每个账号在 `Documents/WXWork/<vid>/Data` 下有独立数据目录，而 Store 只在
**启动时**解析一次目录，之后主循环一直盯着启动时那个。换号后旧目录不再写入，
`wal_signature` 永远不变 → 不再 refresh → 扫不到任何新消息，日志只有
「上报：无新增消息」，和「没人发消息」完全一样。

实测后果：换号后所有客户都不回，重启进程才恢复；而且新旧账号的 message_id
还会撞车（见 reply_store 里 UNIQUE(message_id) 的问题）。

这里锁定三条行为：
  1. 目录变了 → account_switched 返回新目录
  2. 目录没变 → 返回 None（不能每轮都退出）
  3. 显式配了 data_dir 的机器不被自动切走（运营明确指定了盯哪个账号）
"""

from __future__ import annotations

import inspect
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot


@pytest.fixture
def agent():
    return load_autopilot()


def make_dir(tmp_path: Path, name: str) -> Path:
    folder = tmp_path / name / "Data"
    folder.mkdir(parents=True)
    for database in ("message.db", "session.db"):
        (folder / database).touch()
    return folder


def test_returns_new_directory_when_account_changed(agent, tmp_path, monkeypatch):
    old = make_dir(tmp_path, "1688858186855249")
    new = make_dir(tmp_path, "1688855894882096")
    monkeypatch.setattr(agent, "find_data_dir", lambda: new)

    switched = agent.account_switched(old)

    assert switched == new


def test_returns_none_when_directory_is_unchanged(agent, tmp_path, monkeypatch):
    same = make_dir(tmp_path, "1688855894882096")
    monkeypatch.setattr(agent, "find_data_dir", lambda: same)

    assert agent.account_switched(same) is None


def test_returns_none_when_no_directory_resolved(agent):
    """读不到目录（企微刚退出、目录被移走）不能当成「换号了」去退出。"""
    monkeypatch = pytest.MonkeyPatch()
    try:
        monkeypatch.setattr(agent, "find_data_dir", lambda: None)
        assert agent.account_switched(Path("/nonexistent/Data")) is None

        def boom():
            raise OSError("no access")

        monkeypatch.setattr(agent, "find_data_dir", boom)
        assert agent.account_switched(Path("/nonexistent/Data")) is None
    finally:
        monkeypatch.undo()


def test_returns_none_without_a_reference_directory(agent):
    probe = MagicMock(return_value=Path("/x/Data"))
    monkeypatch = pytest.MonkeyPatch()
    try:
        monkeypatch.setattr(agent, "find_data_dir", probe)
        assert agent.account_switched(None) is None
        assert agent.account_switched("") is None
        probe.assert_not_called()
    finally:
        monkeypatch.undo()


def test_watch_loop_exits_only_for_discovered_directories(agent):
    """循环里必须以 `data_dir is None` 为条件：显式指定目录的机器不自动退出。"""
    source = inspect.getsource(agent.main)
    assert "account_switched(" in source, "watch 循环里没有接换号检测"
    assert "if data_dir is None:" in source, "换号检测必须只在自动发现目录时生效"
    assert "ACCOUNT_SWITCH_EXIT_CODE" in source, "换号后必须以专用退出码退出，交给守护进程重启"
    assert agent.ACCOUNT_SWITCH_EXIT_CODE != 0, "退出码不能是 0，否则和正常退出分不开"
