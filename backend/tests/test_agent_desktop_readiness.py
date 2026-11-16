"""Exercise Windows read-only desktop probes through simulated native APIs."""
import ctypes
from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot


def desktop_api(monkeypatch, *, session_state=0, desktop_name='Default'):
    agent = load_autopilot()
    kernel, wts, user = MagicMock(), MagicMock(), MagicMock()
    kernel.GetCurrentProcessId.return_value = 4240
    state = ctypes.c_int(session_state)

    def process_session(pid, output):
        output._obj.value = 2
        return True

    def query(server, session, info_class, output, size):
        assert session == 2 and info_class == 8
        output._obj.value = ctypes.addressof(state)
        size._obj.value = ctypes.sizeof(state)
        return True

    def object_name(handle, info_class, output, size, needed):
        assert handle == 42 and info_class == 2
        output.value = desktop_name
        return True

    kernel.ProcessIdToSessionId.side_effect = process_session
    wts.WTSQuerySessionInformationW.side_effect = query
    user.OpenInputDesktop.return_value = 42
    user.GetUserObjectInformationW.side_effect = object_name
    libraries = {'kernel32': kernel, 'wtsapi32': wts, 'user32': user}
    monkeypatch.setattr(agent.ctypes, 'WinDLL', lambda name, **kw: libraries[name], raising=False)
    return agent, kernel, wts, user


def test_connected_default_desktop_checks_only_read_rights_and_closes_handles(monkeypatch):
    agent, kernel, wts, user = desktop_api(monkeypatch)
    assert agent._windows_desktop_status() == (True, '')
    user.OpenInputDesktop.assert_called_once_with(0, False, 1)
    user.CloseDesktop.assert_called_once_with(42)
    wts.WTSFreeMemory.assert_called_once()
    user.SwitchDesktop.assert_not_called()
    user.SetThreadDesktop.assert_not_called()
    agent.core_send.send.assert_not_called()


@pytest.mark.parametrize('state', [1, 4, 5, 8])
def test_disconnected_or_unavailable_session_stops_before_input_desktop(monkeypatch, state):
    agent, kernel, wts, user = desktop_api(monkeypatch, session_state=state)
    ready, reason = agent._windows_desktop_status()
    assert not ready and '未连接' in reason
    wts.WTSFreeMemory.assert_called_once()
    user.OpenInputDesktop.assert_not_called()


def test_secure_desktop_is_not_treated_as_ready(monkeypatch):
    agent, kernel, wts, user = desktop_api(monkeypatch, desktop_name='Winlogon')
    ready, reason = agent._windows_desktop_status()
    assert not ready and '安全桌面' in reason
    user.CloseDesktop.assert_called_once_with(42)


def test_inaccessible_input_desktop_stays_paused(monkeypatch):
    agent, kernel, wts, user = desktop_api(monkeypatch)
    user.OpenInputDesktop.return_value = 0
    ready, reason = agent._windows_desktop_status()
    assert not ready and '锁屏' in reason
    user.CloseDesktop.assert_not_called()


def test_native_query_failure_does_not_assume_ready(monkeypatch):
    agent, kernel, wts, user = desktop_api(monkeypatch)
    wts.WTSQuerySessionInformationW.side_effect = None
    wts.WTSQuerySessionInformationW.return_value = False
    assert agent._windows_desktop_status()[0] is False
    user.OpenInputDesktop.assert_not_called()


def test_probe_exception_never_reaches_sender(monkeypatch):
    agent, kernel, wts, user = desktop_api(monkeypatch)
    kernel.ProcessIdToSessionId.side_effect = OSError('synthetic native failure')
    ready, reason = agent._windows_desktop_status()
    assert not ready and '自检失败' in reason
    agent.core_send.send.assert_not_called()
