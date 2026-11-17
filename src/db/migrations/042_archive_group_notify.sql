-- 面试登记群聊通知（2026-11-17）：档案里 name/phone/面试时间齐全后，把
-- 「时间 + 姓名 + 电话」推送到设备绑定的群聊（agent_devices.data_json.group_chat）。
-- group_notified：通知幂等标记（0=待通知；档案每次更新都写，靠它防止重复推送）。
ALTER TABLE agent_archive ADD COLUMN group_notified INTEGER NOT NULL DEFAULT 0;
