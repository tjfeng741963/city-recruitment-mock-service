from contextlib import closing
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest


SOURCE = Path(__file__).resolve().parents[2] / "agent" / "reply_store.py"
CONVERSATION = "S:employee_customer"
LEGACY_REASON = "会话没有可搜索的名字"
TITLE_REASON = "发送前无法核对企微当前会话，已保留待回复记录"


class RecipientRecoveryTest(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "reply_log.db"
        self.store = self.load_store()

    def load_store(self):
        spec = spec_from_file_location("reply_store_recipient_test", SOURCE)
        store = module_from_spec(spec)
        spec.loader.exec_module(store)
        store.DB_PATH = self.path
        store.init()
        return store

    def record(self, message_id, *, sent_at=200, text="你好", conversation=CONVERSATION):
        self.assertTrue(self.store.record_incoming({
            "id": message_id, "conv_id": conversation, "conv_name": "1",
            "text": text, "type": 2, "time": sent_at,
        }))

    def restore(self, message_id="1", *, cutoff=100, outbound_at=0, name="松下候选人-029"):
        return self.store.restore_recipient_blocked(
            CONVERSATION, message_id, conv_name=name, cutoff=cutoff, outbound_at=outbound_at,
        )

    def test_holds_across_restart_and_restores_once(self):
        self.record("1")
        self.assertTrue(self.store.mark_recipient_blocked("1", CONVERSATION, "同名联系人"))
        self.assertEqual(self.store.pending(), [])
        self.store = self.load_store()
        candidate = self.store.recipient_blocked(CONVERSATION)
        self.assertEqual((candidate["status"], candidate["last_step"], candidate["in_text"]),
                         ("held", "recipient-blocked", "你好"))

        self.assertTrue(self.restore())
        self.assertFalse(self.restore())
        self.assertIsNone(self.store.recipient_blocked(CONVERSATION))
        self.assertEqual(len(self.store.pending()), 1)
        self.assertEqual(self.store.pending()[0]["conv_name"], "松下候选人-029")
        self.assertEqual(self.store.pending()[0]["attempts"], 0)

    def test_latest_legacy_name_skip_recovers_but_other_skip_stays(self):
        self.record("1", sent_at=199)
        self.record("2")
        self.record("system", sent_at=201, text="\t\n")
        self.store.mark_skipped("1", CONVERSATION, "同会话合并到最新一条")
        self.store.mark_skipped("2", CONVERSATION, LEGACY_REASON)
        self.store.mark_skipped("system", CONVERSATION, "系统会话")

        self.assertEqual(self.store.recipient_blocked(CONVERSATION)["message_id"], "2")
        self.assertFalse(self.restore())
        self.assertTrue(self.restore("2"))
        self.assertEqual([r["message_id"] for r in self.store.pending()], ["2"])

    def test_unknown_outbound_same_timestamp_outbound_and_stale_never_requeue(self):
        self.record("1")
        self.store.mark_recipient_blocked("1", CONVERSATION, "同名联系人")
        self.assertFalse(self.restore(outbound_at=None))
        self.assertFalse(self.restore(outbound_at=200))
        self.assertFalse(self.restore(outbound_at=201))
        self.assertFalse(self.restore(cutoff=201))
        self.assertFalse(self.restore(name="  "))
        self.assertEqual(self.store.pending(), [])
        self.assertTrue(self.restore(outbound_at=199, cutoff=200))

    def test_latest_only_and_checks_again_at_send(self):
        self.record("1")
        self.store.mark_recipient_blocked("1", CONVERSATION, "同名联系人")
        self.record("2", conversation="S:other_account_customer", sent_at=202)
        self.assertTrue(self.restore())

        self.record("3", sent_at=203)
        self.assertFalse(self.store.begin_reply_attempt("1", CONVERSATION, "回复"))
        self.assertEqual([r["message_id"] for r in self.store.pending()], ["2", "3"])

        self.record("4", sent_at=204)
        self.store.mark_recipient_blocked("4", CONVERSATION, "同名联系人")
        self.record("5", sent_at=204)
        self.assertIsNone(self.store.recipient_blocked(CONVERSATION))
        self.assertFalse(self.restore("4"))

    def test_never_requeues_attempted_unknown_partial_or_generic_failure(self):
        for state in ("failed", "sending", "unknown", "partial", "sent", "held"):
            with self.subTest(state=state):
                self.record(state, conversation=f"S:employee_{state}")
                conversation = f"S:employee_{state}"
                if state == "failed":
                    self.store.mark_failed(state, conversation, "failed")
                elif state == "sending":
                    self.store.begin_reply_attempt(state, conversation, "回复")
                elif state in ("unknown", "partial"):
                    self.store.mark_unknown(state, conversation, "not verified", partial=state == "partial")
                elif state == "sent":
                    self.store.mark_sent(state, conversation, "回复", "已回复")
                else:
                    self.store.mark_held(state, conversation, "知识库错误")
                self.assertFalse(self.store.mark_recipient_blocked(state, conversation, "同名联系人"))
                self.assertIsNone(self.store.recipient_blocked(conversation))
                self.assertFalse(self.store.restore_recipient_blocked(
                    conversation, state, conv_name="confirmed", cutoff=100, outbound_at=0,
                ))

    def test_held_welcome_and_unresolved_send_on_same_conversation_block_recovery(self):
        self.record("1")
        self.store.mark_recipient_blocked("1", CONVERSATION, "同名联系人")
        self.store.begin_welcome(CONVERSATION, "1", False)
        self.assertFalse(self.restore())
        self.store.cancel_welcomes()

        self.record("opening", sent_at=199, text="")
        self.store.begin_reply_attempt("opening", CONVERSATION, "开场")
        self.assertFalse(self.restore())

    def test_only_explicitly_tagged_never_attempted_failure_can_restore(self):
        self.record("1")
        with closing(self.store._conn()) as db, db:
            db.execute("UPDATE reply_log SET status='failed',last_step='failed' WHERE message_id='1'")
        self.assertIsNone(self.store.recipient_blocked(CONVERSATION))
        self.assertFalse(self.store.mark_recipient_blocked("1", CONVERSATION, "同名联系人"))
        with closing(self.store._conn()) as db, db:
            db.execute("UPDATE reply_log SET last_step='recipient-blocked' WHERE message_id='1'")
        self.assertEqual(self.store.pending(), [])
        self.assertFalse(self.store.begin_reply_attempt("1", CONVERSATION, "回复"))
        self.assertTrue(self.restore())

    def test_discovery_includes_latest_legacy_and_current_holds_after_restart(self):
        self.record("1")
        self.store.mark_recipient_blocked("1", CONVERSATION, "同名联系人")
        self.record("2", sent_at=175, conversation="S:employee_legacy")
        self.store.mark_skipped("2", "S:employee_legacy", LEGACY_REASON)
        self.record("3", sent_at=174, conversation="S:employee_other")
        self.store.mark_skipped("3", "S:employee_other", LEGACY_REASON)
        self.record("4", sent_at=210, conversation="S:employee_other")
        self.store = self.load_store()
        self.assertEqual(self.store.recipient_blocked_conversations(150),
                         [CONVERSATION, "S:employee_legacy"])
        self.assertEqual(self.store.recipient_blocked_conversations(176), [CONVERSATION])
        self.assertEqual(self.store.recipient_blocked_conversations(201), [])

    def reviewed_title(self, message_id="1", **kwargs):
        return self.store.queue_reply_recovery(
            CONVERSATION, message_id, reason="verified WeCom history", operator="operator",
            title_recovery=True, **kwargs,
        )

    def test_reviewed_old_title_failure_preserves_scene_and_is_audited(self):
        self.record("1")
        self.store.mark_held("1", CONVERSATION, TITLE_REASON, "Agent")
        self.assertEqual(self.store.recipient_blocked_conversations(201, title_retry=True), [])
        self.assertEqual(self.reviewed_title(), "queued")
        self.store = self.load_store()
        self.assertEqual(self.reviewed_title(), "already_queued")
        self.assertEqual(self.store.hold_before(201), 0)
        row, = self.store.pending()
        self.assertEqual((row["scene"], row["last_step"], row["attempts"]),
                         ("Agent", "reviewed-title-recovery-queued", 0))
        receipt, = self.store.recent_reply_recoveries()
        self.assertIsNone(receipt["finished_at"])
        self.assertEqual(row["reviewed_title_requested_at"], receipt["requested_at"])
        self.assertEqual((receipt["operator"], receipt["previous_error"]), ("operator", TITLE_REASON))
        self.record("2", sent_at=201)
        self.assertFalse(self.store.begin_reply_attempt("1", CONVERSATION, "Agent"))
        self.assertEqual(self.store.recent_reply_recoveries()[0]["outcome"], "skipped")

    def test_reviewed_title_failure_rejects_other_states_and_unresolved_delivery(self):
        self.record("1")
        self.store.mark_held("1", CONVERSATION, "生成失败")
        self.assertEqual(self.reviewed_title(), "not_eligible")
        self.store.mark_held("1", CONVERSATION, TITLE_REASON, "Agent")
        self.assertEqual(self.reviewed_title(legacy_sent=True), "not_eligible")
        self.store.begin_welcome(CONVERSATION, "1", False)
        self.assertEqual(self.reviewed_title(), "welcome_pending")
        self.store.cancel_welcomes()

        self.record("other-attempt", sent_at=199, text="")
        self.store.mark_unknown("other-attempt", CONVERSATION, "未确认", partial=True)
        self.assertEqual(self.reviewed_title(), "not_eligible")
        self.assertEqual(self.store.pending(), [])

    def test_reviewed_title_does_not_queue_opening_or_attempted_reply(self):
        self.record("1")
        self.store.mark_held("1", CONVERSATION, TITLE_REASON, "开场")
        self.assertEqual(self.reviewed_title(), "not_eligible")
        self.record("2", sent_at=201)
        self.store.mark_failed("2", CONVERSATION, "送达未确认")
        self.store.mark_held("2", CONVERSATION, TITLE_REASON)
        self.assertEqual(self.reviewed_title("2"), "not_eligible")
        self.assertEqual(self.store.pending(), [])

    def test_generic_recovery_cannot_bypass_recipient_hold(self):
        self.record("1")
        self.store.mark_recipient_blocked("1", CONVERSATION, "同名联系人")
        self.assertEqual(self.store.queue_reply_recovery(
            CONVERSATION, "1", reason="review", operator="operator",
        ), "not_eligible")
        self.assertEqual(self.store.pending(), [])


    def test_automatically_restored_text_can_expire_before_send(self):
        self.record("1")
        self.store.mark_recipient_blocked("1", CONVERSATION, "同名联系人")
        self.assertTrue(self.restore())
        self.assertEqual(self.store.hold_before(201), 1)
        self.assertEqual(self.store.pending(), [])
        self.assertFalse(self.store.begin_reply_attempt("1", CONVERSATION, "回复"))


if __name__ == "__main__":
    unittest.main()
