-- 设备登录二维码：云端机器上的企微掉登录时，把扫码窗截下来给网页显示。
--
-- 为什么需要这张表：机器在云端（134.175.40.31 这类专用机），运营和客户都看不到
-- 那块屏幕。企微被风控登出后会弹出二维码，必须有人用手机扫——不把图送到网页，
-- 这件事故障后只能等现场有人去看屏幕，自动回复就无限期停摆。
--
-- 只存"最新一张"，按 device_code 唯一：二维码本身有有效期（约 2 分钟自动刷新），
-- 历史帧没有任何价值，留着只会让库膨胀（一张 200KB，一分钟能上传 3 次）。
-- 客户端每次刷新都会覆盖这一行。
CREATE TABLE IF NOT EXISTS device_login_qr (
  device_code TEXT PRIMARY KEY,
  -- PNG 的 base64。为什么不存文件：只有一个消费方（网页设备页），
  -- 单行覆盖写最简单，不需要清理任务，也不怕容器重建丢文件。
  image_b64 TEXT NOT NULL,
  -- 图片像素宽高，前端用来撑开占位、避免加载时跳版
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  -- 客户端截图时刻（ISO8601）。前端据此显示"看到的是几秒前的画面"，
  -- 超过 90 秒就提示二维码可能已过期、正在等新的一帧。
  captured_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
