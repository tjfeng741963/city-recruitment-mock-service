-- 老友「不可聊 / 可聊」的状态词表与前端对齐。
--
-- 前端（OldFriendView）只认 released / unreleased：
--   可聊 = released，不可聊 = unreleased，筛选项也只有这两个值。
-- 后端过去在 unrelease 里写的是 'active'，种子行也是 'active'，
-- 于是页面出现「总老友 1、不可聊 0、可聊 0」这种对不上的数字，
-- 行内徽标则因为 !== 'released' 而一律显示「不可聊」。
--
-- 统一到 released / unreleased：老客户默认不可聊（unreleased），
-- 运营手动放行后才是 released。存量 active 一并归一到 unreleased。
UPDATE old_friend_records SET status='unreleased' WHERE status IN ('active','');
UPDATE old_friend_records SET status='released' WHERE status='released';
