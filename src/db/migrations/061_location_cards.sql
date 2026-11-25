-- 企微原生位置卡（2026-11-25）
--
-- 背景：客户问面试地点时，过去只能回一段文字 + 高德链接（buildMapLink），
-- 客户拿不到那张能点开导航的企微原生位置卡。
--
-- 企微 PC 端没有「发送位置」入口，也不能凭空构造位置消息；但实测发现：
-- 右键任意一条位置消息 →「复制」，剪贴板里会写入一个自定义格式
-- `WeWork Message`（353 字节，Boost serialization 包 protobuf，含经纬度/
-- 名称/地址）。把这个二进制块用 SetClipboardData 写回剪贴板，再在目标会话
-- Ctrl+V，就能粘出同一张原生卡——不需要收藏、不需要转发、不需要鼠标点菜单。
--
-- 所以这里只存「采集到的那块字节」：一次采集、永久复用，发送时下发 base64。
--
-- 为什么按 sha256 做主键：同一张卡被反复采集（换个会话再复制一次）内容完全
-- 一致，天然去重；同时给面试点绑定提供稳定标识（data_json 里只存 sha）。
--
-- 为什么不存进 media_assets：媒体表按 name 唯一且带 kind/storage_path，
-- 位置卡没有文件、只有一块剪贴板字节，混进去会把媒体下发链路弄脏。

CREATE TABLE IF NOT EXISTS location_cards (
  sha256 TEXT PRIMARY KEY,          -- 剪贴板字节的 sha256（64 hex）
  blob_b64 TEXT NOT NULL,           -- WeWork Message 原始字节的 base64
  bytes INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL DEFAULT '',    -- 从字节里尽力提取的名称（如「广汽本田龙华店」）
  address TEXT NOT NULL DEFAULT '', -- 从字节里尽力提取的地址
  device_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_location_cards_created ON location_cards(created_at);
