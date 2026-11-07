"""Importing the orchestrator must preserve the sender's input behavior."""
from __future__ import annotations

import sys

import pytest

from tests import agent_loader


def test_startup_only_enables_non_input_compatibility_patches():
    autopilot = agent_loader.load_autopilot()

    autopilot.compat.apply.assert_called_once_with()
    autopilot.compat.apply_pb_text.assert_called_once_with()
    autopilot.compat.apply_click_input.assert_not_called()
    autopilot.compat.apply_foreground.assert_not_called()
    autopilot.core_send.send.assert_not_called()


@pytest.mark.parametrize("core_default", [0.8, 1.25])
def test_startup_preserves_sender_owned_search_delay(monkeypatch, core_default):
    load_module = agent_loader._load_module

    def load_with_core_default(name):
        if name == "autopilot":
            sys.modules["wecom_io_core"].send.SEARCH_DELAY = core_default
        return load_module(name)

    monkeypatch.setattr(agent_loader, "_load_module", load_with_core_default)
    autopilot = agent_loader.load_autopilot()

    assert autopilot.core_send.SEARCH_DELAY == core_default
