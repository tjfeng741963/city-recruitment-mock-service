"""急停开关的测试：只验证「文件存在即关闭、删掉即恢复、互不干扰」。

所有用例都把 ``LEAD_GUARD_DIR`` 指向 ``tmp_path``，不碰真实的 backend/data，
否则会顺手把开发机的开关打开/关掉。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services import lead_guard
from app.services.lead_guard import extract_enabled, status, sweep_enabled


@pytest.fixture
def guard_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """把开关目录换到临时目录，用例之间互不影响。"""
    monkeypatch.setenv("LEAD_GUARD_DIR", str(tmp_path))
    return tmp_path


def test_default_both_enabled(guard_dir: Path) -> None:
    """没有任何开关文件时，两个功能都开。"""
    assert extract_enabled() == (True, "")
    assert sweep_enabled() == (True, "")


def test_extract_off_does_not_affect_sweep(guard_dir: Path) -> None:
    """建 LEAD_EXTRACT_OFF 后抽取关闭，扫描仍开。"""
    (guard_dir / "LEAD_EXTRACT_OFF").touch()

    enabled, reason = extract_enabled()
    assert enabled is False
    assert "LEAD_EXTRACT_OFF" in reason

    assert sweep_enabled() == (True, "")


def test_sweep_off_does_not_affect_extract(guard_dir: Path) -> None:
    """反过来也一样：扫描关闭不影响抽取。"""
    (guard_dir / "LEAD_SWEEP_OFF").touch()

    enabled, reason = sweep_enabled()
    assert enabled is False
    assert "LEAD_SWEEP_OFF" in reason

    assert extract_enabled() == (True, "")


def test_no_cache_reflects_changes_immediately(guard_dir: Path) -> None:
    """同进程内建文件立刻关闭、删文件立刻恢复，证明没有缓存。"""
    assert extract_enabled()[0] is True

    (guard_dir / "LEAD_EXTRACT_OFF").touch()
    assert extract_enabled()[0] is False

    (guard_dir / "LEAD_EXTRACT_OFF").unlink()
    assert extract_enabled()[0] is True

    # 扫描开关同样不该被缓存
    (guard_dir / "LEAD_SWEEP_OFF").touch()
    assert sweep_enabled()[0] is False
    (guard_dir / "LEAD_SWEEP_OFF").unlink()
    assert sweep_enabled()[0] is True


def test_status_structure(guard_dir: Path) -> None:
    """status() 的键与类型固定，前端/脚本照着读。"""
    data = status()

    assert set(data) == {"extract", "sweep", "data_dir"}
    assert data["extract"] == {"enabled": True, "reason": ""}
    assert data["sweep"] == {"enabled": True, "reason": ""}
    assert data["data_dir"] == str(guard_dir)

    (guard_dir / "LEAD_EXTRACT_OFF").touch()
    data = status()
    assert data["extract"]["enabled"] is False
    assert data["extract"]["reason"] != ""
    assert data["sweep"]["enabled"] is True
    assert data["sweep"]["reason"] == ""


def test_missing_dir_is_enabled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """目录不存在时不报错，按开启处理（没人关过就不该拦主流程）。"""
    missing = tmp_path / "not-created-yet"
    monkeypatch.setenv("LEAD_GUARD_DIR", str(missing))

    assert missing.exists() is False
    assert extract_enabled() == (True, "")
    assert sweep_enabled() == (True, "")
    assert status()["data_dir"] == str(missing)


def test_default_dir_anchored_to_backend_data(monkeypatch: pytest.MonkeyPatch) -> None:
    """默认目录必须锚定 __file__（backend/data），不能是相对路径 data/。"""
    monkeypatch.delenv("LEAD_GUARD_DIR", raising=False)

    assert lead_guard.DATA_DIR.is_absolute()
    assert lead_guard.DATA_DIR.name == "data"
    assert lead_guard.DATA_DIR.parent.name == "backend"
    assert lead_guard.DATA_DIR == Path(lead_guard.__file__).resolve().parents[2] / "data"
    assert status()["data_dir"] == str(lead_guard.DATA_DIR)
