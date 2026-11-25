import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deploy" / "client"))
import client_updater


ASSIGNMENT = {"id": "11111111-1111-4111-8111-111111111111",
              "device_code": "AG-target", "bridge_token": "b" * 64}


def test_interactive_pool_assignment_is_trial_only_and_survives_retry(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"device_code": "pool-01", "brain": {"mode": "fixed"},
                                  "bridge_token": "a" * 64, "register_key": "unused", "target": "legacy"}))
    manager = MagicMock()
    manager.start_on_logon.side_effect = [OSError("startup temporarily unavailable"), True]
    config_data = client_updater.cloud_agent_config(tmp_path)
    assert config_data is None
    (tmp_path / "cloud-agent-pool.json").write_text(json.dumps({"machine_code": "pool-01", "origin": "https://example.org"}))
    config_data = client_updater.cloud_agent_config(tmp_path)
    manager.status.return_value = {"running": 0, "other_running": 0}
    with pytest.raises(OSError):
        client_updater.apply_cloud_agent_assignment(tmp_path, manager, config_data, ASSIGNMENT)
    first = json.loads(config.read_text())
    assert first == {"device_code": "AG-target", "bridge_server": "https://example.org",
                     "bridge_token": "b" * 64, "dry_run": True, "brain": {"mode": "agent"},
                     "cloud_assignment_id": ASSIGNMENT["id"]}
    client_updater.apply_cloud_agent_assignment(tmp_path, manager, config_data, ASSIGNMENT)
    assert json.loads(config.read_text()) == first
    assert json.loads((tmp_path / "config.before-cloud-assignment.json").read_text())["device_code"] == "pool-01"


def test_pool_rejects_plaintext_and_an_in_use_windows_client(tmp_path):
    marker = tmp_path / "cloud-agent-pool.json"
    marker.write_text(json.dumps({"machine_code": "pool-01", "origin": "http://example.org"}))
    with pytest.raises(client_updater.UpdateError):
        client_updater.cloud_agent_config(tmp_path)
    marker.write_text(json.dumps({"machine_code": "pool-01", "origin": "https://example.org"}))
    (tmp_path / "config.json").write_text(json.dumps({"device_code": "live-customer", "bridge_token": "a" * 64}))
    manager = MagicMock()
    with pytest.raises(client_updater.UpdateError):
        client_updater.apply_cloud_agent_assignment(tmp_path, manager, client_updater.cloud_agent_config(tmp_path), ASSIGNMENT)
    manager.start_on_logon.assert_not_called()


def test_pool_rejects_previous_wecom_account_data(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    (tmp_path / "config.json").write_text(json.dumps({"device_code": "pool-01", "bridge_token": "a" * 64}))
    wecom = tmp_path / "Documents" / "WXWork" / "personal-account" / "Data"
    wecom.mkdir(parents=True)
    (wecom / "message.db").touch()
    manager = MagicMock()
    manager.status.return_value = {"running": 0, "other_running": 0}
    with pytest.raises(client_updater.UpdateError, match="已有企微"):
        client_updater.apply_cloud_agent_assignment(tmp_path, manager, ("pool-01", "https://example.org"), ASSIGNMENT)
    assert json.loads((tmp_path / "config.json").read_text())["device_code"] == "pool-01"
    manager.start_on_logon.assert_not_called()


def test_cloud_assignment_respects_manual_stop(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    (tmp_path / "config.json").write_text(json.dumps({"device_code": "pool-01", "bridge_token": "a" * 64}))
    (tmp_path / "logs").mkdir()
    marker = tmp_path / "logs" / "manual-stop"
    marker.touch()
    manager = MagicMock()
    assert client_updater.apply_cloud_agent_assignment(tmp_path, manager, ("pool-01", "https://example.org"), ASSIGNMENT) is False
    assert json.loads((tmp_path / "config.json").read_text())["device_code"] == "pool-01"
    manager.start_on_logon.assert_not_called()


@pytest.mark.parametrize("started", [True, False])
def test_pool_logon_preserves_supervision(tmp_path, monkeypatch, started):
    import client_manager_service

    (tmp_path / client_updater.CLOUD_AGENT_MARKER).touch()
    manager = MagicMock()
    monkeypatch.setattr(client_manager_service, "ManagerService", lambda root: manager)
    monkeypatch.setattr(client_updater, "ROOT", tmp_path)
    monkeypatch.setattr(client_updater, "wait_for_cloud_agent", lambda root, service: started)
    monkeypatch.setattr(sys, "argv", ["client_updater.py", "--supervise"])
    assert client_updater.main() == 0
    assert manager.supervise.call_count == int(started)
