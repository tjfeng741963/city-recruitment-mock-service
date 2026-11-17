-- 设备群聊清单（2026-11-17）：设备端定期从企微本地库上报群聊列表
-- （wecom_io_core sessions type='群聊'），管理端「面试登记」面板下拉自选
-- 绑定群聊（选中值落 agent_devices.data_json.group_chat）。
CREATE TABLE IF NOT EXISTS device_group_chats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_code TEXT NOT NULL,
    conv_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    updated_at  REAL
);
CREATE INDEX IF NOT EXISTS idx_group_chats_device ON device_group_chats(device_code);
