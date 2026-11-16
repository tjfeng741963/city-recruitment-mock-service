"""Durable greeting recovery with synthetic contacts and no desktop input."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from tests.agent_loader import load_autopilot, load_reply_store
from tests.test_autopilot_welcome import CFG, PARTS, setup_agent

UNSENT = {'ok': False, 'detail': '抢不到前台，已中止', 'conversation_id': ''}


def incoming(agent, text='工资多少', mid=2):
    agent.rlog.record_incoming({'id': mid, 'conv_id': 'S:test', 'conv_name': '专用测试联系人',
                                'text': text, 'type': 2, 'time': 100 + mid})


def confirmed_sender(agent, store):
    def send(*args, **kwargs):
        store.outbox.append({'id': f'out-{len(store.outbox)}', 'sender_id': 'test', 'text': args[2]})
        return {'ok': True, 'detail': 'mock database readback', 'conversation_id': 'S:test'}
    agent.core_send.send.side_effect = send


def restarted(agent, store, monkeypatch):
    again = load_autopilot()
    monkeypatch.setattr(again, 'rlog', load_reply_store(agent.rlog.DB_PATH))
    monkeypatch.setattr(again, 'GREET_STATE', agent.GREET_STATE)
    monkeypatch.setattr(again.time, 'sleep', lambda _: None)
    again._brain = MagicMock(mode='flow')
    again._brain.greet.side_effect = AssertionError('Must reuse the original welcome')
    again._last_reply_at = 0
    confirmed_sender(again, store)
    return again


def test_failed_welcome_survives_later_question_restart_and_backend_config_change(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.core_send.send.return_value = UNSENT
    assert agent.drain(store, CFG)['failed'] == 1
    assert not agent.GREET_STATE.exists()
    saved = agent.rlog.welcome('S:test')
    assert saved['state'] == 'ready' and saved['parts'] == PARTS and saved['next_part'] == 0
    incoming(agent)

    again = restarted(agent, store, monkeypatch)
    assert again.drain(store, CFG)['sent'] == 1
    assert [call.args[2] for call in again.core_send.send.call_args_list] == PARTS
    again._brain.reply.assert_not_called()
    assert again._load_greeted() == {'S:test'}
    assert [(r['message_id'], r['in_text']) for r in again.rlog.pending()] == [('2', '工资多少')]
    again._brain.reply.return_value = {'ok': True, 'reply': '本厂工资，模拟事实', 'scene': '流程'}
    assert again.drain(store, CFG)['sent'] == 1
    assert again._brain.reply.call_args.args[0] == '工资多少'
    assert again.rlog.welcome('S:test')['parts'] == PARTS


def test_partial_welcome_resumes_only_unconfirmed_parts(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    original_send = agent.core_send.send.side_effect
    def send(*args, **kwargs):
        return UNSENT if len(store.outbox) == 1 else original_send(*args, **kwargs)
    agent.core_send.send.side_effect = send
    assert agent.drain(store, CFG)['failed'] == 1
    assert agent.rlog.welcome('S:test')['next_part'] == 1
    assert not agent.GREET_STATE.exists()
    again = restarted(agent, store, monkeypatch)
    assert again.drain(store, CFG)['sent'] == 1
    assert [call.args[2] for call in again.core_send.send.call_args_list] == PARTS[1:]
    assert [m['text'] for m in store.outbox] == PARTS


@pytest.mark.parametrize('result', [
    {'ok': True, 'conversation_id': '', 'detail': '已发送但回读失败'},
    {'ok': False, 'conversation_id': 'S:other', 'detail': '发到了别的会话'},
    {'ok': False, 'detail': '未知错误'},
])
def test_uncertain_result_is_held_and_not_replayed_or_bypassed(tmp_path, monkeypatch, result):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.core_send.send.side_effect = None  # No new outbound message in the snapshot.
    agent.core_send.send.return_value = result
    assert agent.drain(store, CFG)['failed'] == 1
    assert agent.rlog.welcome('S:test')['state'] == 'held'
    assert not agent.GREET_STATE.exists()
    assert agent.rlog.retry_held() == 0
    incoming(agent)
    again = restarted(agent, store, monkeypatch)
    assert again.drain(store, CFG)['blocked'] == 1
    again.core_send.send.assert_not_called()
    again._brain.reply.assert_not_called()
    assert agent.rlog.welcome('S:test')['parts'] == PARTS


def test_process_crash_during_send_holds_unknown_after_restart(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    def crash(*args, **kwargs):
        store.outbox.append({'id': 'possibly-sent', 'sender_id': 'test', 'text': args[2]})
        raise SystemExit('synthetic process crash after input')
    agent.core_send.send.side_effect = crash
    with pytest.raises(SystemExit):
        agent.drain(store, CFG)
    assert agent.rlog.welcome('S:test')['state'] == 'sending'
    again = restarted(agent, store, monkeypatch)
    assert again.drain(store, CFG)['blocked'] == 1
    assert again.rlog.welcome('S:test')['state'] == 'held'
    again.core_send.send.assert_not_called()
    assert not again.GREET_STATE.exists()


def test_crash_during_server_generation_never_regenerates_or_answers_instead(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent._brain.greet.side_effect = SystemExit('HTTP response lost during process crash')
    with pytest.raises(SystemExit):
        agent.drain(store, CFG)
    assert agent.rlog.welcome('S:test')['state'] == 'preparing'
    again = restarted(agent, store, monkeypatch)
    incoming(again)
    assert again.drain(store, CFG)['blocked'] == 1
    again._brain.greet.assert_not_called()
    again._brain.reply.assert_not_called()
    again.core_send.send.assert_not_called()


@pytest.mark.parametrize('response', [
    {'ok': False, 'detail': 'HTTP timeout'},
    {'ok': True, 'reply': '', 'parts': []},
])
def test_generation_failure_does_not_advance_to_normal_answer(tmp_path, monkeypatch, response):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent._brain.greet.return_value = response
    assert agent.drain(store, CFG)['blocked'] == 1
    assert agent.rlog.welcome('S:test')['state'] == 'held'
    agent._brain.reply.assert_not_called()
    agent.core_send.send.assert_not_called()


def test_clipboard_unavailable_keeps_original_for_existing_retry_path(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.compat.wait_clipboard_writable.return_value = False
    assert agent.drain(store, CFG)['failed'] == 1
    assert agent.rlog.welcome('S:test')['state'] == 'ready'
    agent.core_send.send.assert_not_called()
    agent.compat.wait_clipboard_writable.return_value = True
    assert agent.drain(store, CFG)['sent'] == 1
    agent._brain.greet.assert_called_once()


def test_business_question_that_started_welcome_is_answered_next_round(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    incoming(agent, mid=1)
    assert agent.drain(store, CFG)['sent'] == 1
    assert agent.rlog.welcome('S:test')['state'] == 'sent'
    assert agent.rlog.pending()[0]['in_text'] == '工资多少'
    agent._brain.reply.return_value = {'ok': True, 'reply': '本厂工资', 'scene': '流程'}
    assert agent.drain(store, CFG)['sent'] == 1
    assert agent._brain.reply.call_args.args[0] == '工资多少'
    assert not agent.rlog.pending()


def test_disconnected_desktop_never_generates_or_changes_pending_source(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.desktop_send_ready.return_value = (False, 'RDP 已断开')
    assert agent.drain(store, CFG)['blocked'] == 1
    assert agent.rlog.welcome('S:test') is None
    assert agent.rlog.pending()[0]['status'] == 'pending'
    agent._brain.greet.assert_not_called()
    agent.compat.wait_clipboard_writable.assert_not_called()
    agent.core_send.send.assert_not_called()
    assert 'RDP' in agent._last_error
    agent.desktop_send_ready.return_value = (True, '')
    assert agent.drain(store, CFG)['sent'] == 1


def test_desktop_unavailable_keeps_saved_progress_and_no_duplicate_count(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.core_send.send.return_value = UNSENT
    agent.drain(store, CFG)
    agent.core_send.send.reset_mock()
    agent.desktop_send_ready.return_value = (False, '锁屏')
    assert agent.drain(store, CFG)['blocked'] == 1
    assert agent.rlog.welcome('S:test')['state'] == 'ready'
    agent.core_send.send.assert_not_called()


@pytest.mark.parametrize('condition', ['account', 'target', 'mode', 'takeover', 'abandoned'])
def test_saved_welcome_respects_account_scope_and_operator_controls(tmp_path, monkeypatch, condition):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.core_send.send.return_value = UNSENT
    agent.drain(store, CFG)
    agent.core_send.send.reset_mock()
    cfg = dict(CFG)
    if condition == 'account': store.self_id.return_value = 'different-account'
    if condition == 'target': cfg['target'] = 'another-contact'
    if condition == 'mode': agent._brain.mode = 'kb'
    if condition == 'takeover': monkeypatch.setattr(agent.remote_cfg, 'takeover_sessions', lambda: {'S:test'})
    if condition == 'abandoned': monkeypatch.setattr(agent.remote_cfg, 'abandoned_sessions', lambda: {'S:test'})
    agent.drain(store, cfg)
    agent.core_send.send.assert_not_called()
    agent._brain.reply.assert_not_called()
    assert agent.rlog.welcome('S:test')['parts'] == PARTS


def test_ambiguous_duplicate_new_ids_do_not_count_as_confirmed(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    original = agent.core_send.send.side_effect
    def duplicated(*args, **kwargs):
        result = original(*args, **kwargs)
        store.outbox.append({'id': 'duplicate', 'sender_id': 'test', 'text': args[2]})
        return result
    agent.core_send.send.side_effect = duplicated
    assert agent.drain(store, CFG)['failed'] == 1
    assert agent.rlog.welcome('S:test')['state'] == 'held'


def test_old_matching_text_is_not_new_send_evidence(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    store.outbox.append({'id': 'old', 'sender_id': 'test', 'text': PARTS[0]})
    agent.core_send.send.side_effect = None
    assert agent.drain(store, CFG)['failed'] == 1
    assert agent.rlog.welcome('S:test')['next_part'] == 0


def test_explicit_unknown_reconciliation_only_resumes_current_missing_part(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.core_send.send.side_effect = None
    agent.drain(store, CFG)  # ok return, but no database evidence.
    with pytest.raises(ValueError): agent.rlog.resolve_welcome('S:test', 2)
    agent.rlog.resolve_welcome('S:test', 0)  # Operator explicitly checked it was not sent.
    confirmed_sender(agent, store)
    assert agent.drain(store, CFG)['sent'] == 1
    assert [m['text'] for m in store.outbox] == PARTS


def test_success_journal_is_authoritative_if_legacy_marker_cannot_be_written(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    marker_dir = tmp_path / 'marker-directory'
    marker_dir.mkdir()
    monkeypatch.setattr(agent, 'GREET_STATE', marker_dir)
    assert agent.drain(store, CFG)['sent'] == 1
    assert agent.rlog.welcome('S:test')['state'] == 'sent'
    assert not agent._is_first_contact('S:test', set())
    agent.rlog.fail_welcome('S:test', 'late error must not downgrade success', unknown=True)
    assert agent.rlog.recent()[0]['status'] == 'sent'


def test_reset_cancels_welcome_without_later_reactivation(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.core_send.send.return_value = UNSENT
    agent.drain(store, CFG)
    agent.rlog.cancel_welcomes()
    for row in agent.rlog.pending(): agent.rlog.mark_skipped(row['message_id'], 'manual reset')
    assert not agent.rlog.active_welcomes()
    assert not agent._is_first_contact('S:test', set())
    assert agent.drain(store, CFG)['sent'] == 0


def test_resolve_cli_only_updates_journal_and_never_initializes_wecom(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.core_send.send.side_effect = None
    agent.drain(store, CFG)
    agent.core_send.send.reset_mock()
    monkeypatch.setattr(agent, 'ROOT', tmp_path)
    monkeypatch.setattr(agent, 'acquire_single_instance', lambda: True)
    monkeypatch.setattr(agent.sys, 'argv', ['autopilot.py', '--resolve-welcome', 'S:test', '--confirmed-parts', '0'])
    assert agent.main() == 0
    assert agent.rlog.welcome('S:test')['state'] == 'ready'
    agent.Store.assert_not_called()
    agent.core_send.send.assert_not_called()


@pytest.mark.parametrize('method', ['save_welcome', 'begin_welcome_part'])
def test_journal_write_failure_before_input_never_sends(tmp_path, monkeypatch, method):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    def disk_full(*args, **kwargs): raise OSError('synthetic full disk')
    monkeypatch.setattr(agent.rlog, method, disk_full)
    agent.drain(store, CFG)
    agent.core_send.send.assert_not_called()
    assert agent.rlog.welcome('S:test')['state'] == 'held'
    assert not agent.GREET_STATE.exists()


def test_checkpoint_write_failure_after_input_is_unknown_and_never_replayed(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    def disk_full(*args, **kwargs): raise OSError('synthetic checkpoint failure')
    monkeypatch.setattr(agent.rlog, 'confirm_welcome_part', disk_full)
    assert agent.drain(store, CFG)['failed'] == 1
    assert len(store.outbox) == 1
    assert agent.rlog.welcome('S:test')['state'] == 'held'
    again = restarted(agent, store, monkeypatch)
    assert again.drain(store, CFG)['blocked'] == 1
    again.core_send.send.assert_not_called()


def test_pure_media_welcome_never_pastes_into_an_unconfirmed_chat(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent._brain.greet.return_value = {'ok': True, 'reply': '【图片:测试】', 'parts': ['【图片:测试】']}
    agent.core_send.split_media_marks.side_effect = lambda _: ('', [('图片', '测试')])
    assert agent.drain(store, CFG)['failed'] == 1
    agent.core_send.send.assert_not_called()
    agent.core_send.paste_media.assert_not_called()
    assert agent.rlog.welcome('S:test')['state'] == 'held'


def test_media_failure_after_confirmed_text_does_not_replay_the_text(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent._brain.greet.return_value = {'ok': True, 'reply': '介绍【图片:测试】', 'parts': ['介绍【图片:测试】']}
    agent.core_send.split_media_marks.side_effect = lambda _: ('介绍', [('图片', '测试')])
    agent.core_send.paste_media.return_value = (False, 'synthetic failure')
    assert agent.drain(store, CFG)['failed'] == 1
    assert [m['text'] for m in store.outbox] == ['介绍']
    assert agent.rlog.welcome('S:test')['state'] == 'held'
    again = restarted(agent, store, monkeypatch)
    again.drain(store, CFG)
    again.core_send.send.assert_not_called()
    again.core_send.paste_media.assert_not_called()


def test_unknown_retry_cannot_bypass_an_unfinished_welcome(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.core_send.send.side_effect = None
    agent.drain(store, CFG)
    agent.rlog.mark_unknown('1', 'synthetic ordinary unknown marker')
    assert agent.rlog.retry_held() == 0
    assert agent.rlog.welcome('S:test')['state'] == 'held'


def test_confirmed_welcome_accepts_stable_id_despite_inner_readback_failure(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    original_send = agent.core_send.send.side_effect
    def send(*args, **kwargs):
        result = original_send(*args, **kwargs)
        return {**result, 'detail': '已发送但回读失败：synthetic inner snapshot error'}
    agent.core_send.send.side_effect = send
    stats = agent.drain(store, CFG)
    assert stats['sent'] == 1 and stats['unknown'] == 0
    assert agent.rlog.welcome('S:test')['state'] == 'sent'
    assert agent._load_greeted() == {'S:test'}


def test_failed_welcome_retains_main_send_backoff(tmp_path, monkeypatch):
    agent, store = setup_agent(tmp_path, monkeypatch)
    agent.scan(store, CFG)
    agent.core_send.send.side_effect = None
    agent.core_send.send.return_value = UNSENT
    agent._consecutive_send_failures = 0
    assert agent.drain(store, CFG)['failed'] == 1
    assert agent._last_reply_at > 0
    assert agent._consecutive_send_failures == 1
    assert agent.rlog.welcome('S:test')['state'] == 'ready'
