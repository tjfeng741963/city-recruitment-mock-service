-- 媒体资源库（2026-11-14 四端契约）。
--
-- 背景：话术里的 【图片:联测电子厂_门头.jpg】 只是名字，客户端必须能在本地按
-- 这个名字找到文件。过去图片/视频只能靠运营手工拷到每台机器上，换一台机器就丢图。
-- 这里把文件存在服务端（data/media/<sha256>.<ext>），客户端按 name 下载到本地缓存。
--
-- 为什么要 sha256 做文件名：
--   1. 天然去重（同一张图被两条话术引用只存一份）；
--   2. 内容寻址，客户端可以用 X-Content-SHA256 校验下载完整性；
--   3. 文件名不含用户输入，杜绝路径穿越与同名覆盖。
--
-- name 是客户端看到的「业务名」，UNIQUE：同名重传视为替换（改图不改话术）。

CREATE TABLE IF NOT EXISTS media_assets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'enabled',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_assets_sha ON media_assets(sha256);
