-- 社区：本地记住云端账号的 @用户名，用于显示「我的主页」链接与作者身份。
ALTER TABLE sync_account ADD COLUMN handle TEXT NOT NULL DEFAULT '';
