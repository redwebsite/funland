const fs = require('fs');
const path = require('path');
const config = require('../config');

// 确保存储目录存在
if (!fs.existsSync(config.paths.dataDir)) {
  fs.mkdirSync(config.paths.dataDir, { recursive: true });
}

let db;
try {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(config.paths.dbPath);
} catch (e) {
  console.warn('[DB] node:sqlite 初始化警告，尝试常规兼容模式:', e.message);
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      plain_password TEXT DEFAULT '',
      emby_user_id TEXT,
      cookie_115 TEXT,
      cookie_status TEXT DEFAULT 'unbound',
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS cookie_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      cookie TEXT NOT NULL,
      vip_expire TEXT,
      status TEXT DEFAULT 'active',
      last_used_at TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      sha1 TEXT PRIMARY KEY,
      pickcode TEXT,
      file_id TEXT,
      filename TEXT,
      filesize INTEGER,
      source_path TEXT,
      emby_item_id TEXT,
      users_json TEXT DEFAULT '[]',
      play_count INTEGER DEFAULT 0,
      last_played_at TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sha1 TEXT NOT NULL,
      pickcode TEXT NOT NULL,
      file_id TEXT,
      created_at TEXT,
      UNIQUE(user_id, sha1)
    );

    CREATE TABLE IF NOT EXISTS playback_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT,
      item_name TEXT,
      user_id TEXT,
      user_ip TEXT,
      speed_mode TEXT,
      redirect_url TEXT,
      created_at TEXT
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      status TEXT DEFAULT 'unused',
      used_by_user_id INTEGER,
      expires_at TEXT,
      created_at TEXT,
      used_at TEXT
    );
  `);

  // 默认系统配置检查
  const checkSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
  const setSetting = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");

  const defaults = [
    { key: 'emby_upstream_url', value: config.emby.upstreamUrl },
    { key: 'emby_api_key', value: config.emby.apiKey },
    { key: 'acceleration_mode', value: 'PRO' },
    { key: 'cache_ttl_seconds', value: String(config.cache.ttlSeconds) },
    { key: 'allow_registration', value: 'true' },
    { key: 'max_users_limit', value: '200' },
    { key: 'emby_sync_user', value: 'true' },
    { key: 'emby_template_user_id', value: '' },
    { key: 'emby_template_user_name', value: '' },
    { key: 'allow_master_direct_fallback', value: 'false' },
    { key: 'allow_master_for_guests', value: 'false' },
    { key: 'invite_code_required', value: 'true' },   // 注册是否必须邀请码
    { key: 'universal_invite_code', value: '' }        // 通用邀请码（空=禁用）
  ];

  for (const item of defaults) {
    const existing = checkSetting.get(item.key);
    if (!existing) {
      setSetting.run(item.key, item.value, new Date().toISOString());
    }
  }

  // 增量字段迁移
  try { db.exec("ALTER TABLE users ADD COLUMN save_dir_115 TEXT DEFAULT '/EmbyCache';"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN uid_115 TEXT DEFAULT '';"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN plain_password TEXT DEFAULT '';"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN save_cid_115 TEXT DEFAULT '';"); } catch (e) {}
  // 邀请码与会员字段
  try { db.exec("ALTER TABLE users ADD COLUMN invite_code TEXT DEFAULT '';"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN membership_type TEXT DEFAULT '';"); } catch (e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN membership_expires_at TEXT DEFAULT '';"); } catch (e) {}

  console.log('✅ [DB] SQLite 数据库及数据表初始化完成');
}

initTables();

// 辅助查询封装
const dbService = {
  // 设置管理
  getSetting(key, defaultValue = '') {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
      return row ? row.value : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  },
  setSetting(key, value) {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT key FROM settings WHERE key = ?").get(key);
    if (existing) {
      db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = ?").run(String(value), now, key);
    } else {
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(key, String(value), now);
    }
  },
  getAllSettings() {
    return db.prepare("SELECT key, value, updated_at FROM settings").all();
  },

  // 用户管理
  getUserCount() {
    const row = db.prepare("SELECT COUNT(*) as count FROM users").get();
    return row ? row.count : 0;
  },
  findUserByUsername(username) {
    if (username == null) return null;
    const nameStr = String(username).trim();
    if (!nameStr) return null;
    return db.prepare("SELECT * FROM users WHERE username = ?").get(nameStr);
  },
  findUserById(id) {
    if (id == null) return null;
    const numId = parseInt(id, 10);
    if (isNaN(numId)) return null;
    return db.prepare("SELECT * FROM users WHERE id = ?").get(numId);
  },
  findUserByEmbyUserId(embyUserId) {
    if (!embyUserId) return null;
    const idStr = String(embyUserId).trim();
    if (!idStr) return null;
    return db.prepare("SELECT * FROM users WHERE emby_user_id = ?").get(idStr);
  },
  createUser(username, passwordHash, embyUserId = '', plainPassword = '') {
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, emby_user_id, plain_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(username, passwordHash, embyUserId, plainPassword, now, now);
    return result.lastInsertRowid;
  },
  updateUserPlainPassword(id, plainPassword) {
    const now = new Date().toISOString();
    return db.prepare("UPDATE users SET plain_password = ?, updated_at = ? WHERE id = ?").run(plainPassword, now, id);
  },
  updateUserPassword(id, passwordHash, plainPassword = '') {
    const now = new Date().toISOString();
    return db.prepare("UPDATE users SET password_hash = ?, plain_password = ?, updated_at = ? WHERE id = ?").run(passwordHash, plainPassword, now, id);
  },
  updateEmbyUserId(id, embyUserId) {
    const now = new Date().toISOString();
    return db.prepare("UPDATE users SET emby_user_id = ?, updated_at = ? WHERE id = ?").run(embyUserId, now, id);
  },
  deleteUser(id) {
    return db.prepare("DELETE FROM users WHERE id = ?").run(id);
  },
  toggleUserStatus(id) {
    const user = db.prepare("SELECT id, cookie_status FROM users WHERE id = ?").get(id);
    if (!user) return null;
    const newStatus = user.cookie_status === 'disabled' ? 'active' : 'disabled';
    const now = new Date().toISOString();
    db.prepare("UPDATE users SET cookie_status = ?, updated_at = ? WHERE id = ?").run(newStatus, now, id);
    return newStatus;
  },
  updateUser115Cookie(userId, cookie, status = 'active', uid = '', saveDir = null) {
    const now = new Date().toISOString();
    if (saveDir !== null && uid) {
      db.prepare(`
        UPDATE users SET cookie_115 = ?, cookie_status = ?, uid_115 = ?, save_dir_115 = ?, updated_at = ? WHERE id = ?
      `).run(cookie, status, uid, saveDir, now, userId);
    } else if (uid) {
      db.prepare(`
        UPDATE users SET cookie_115 = ?, cookie_status = ?, uid_115 = ?, updated_at = ? WHERE id = ?
      `).run(cookie, status, uid, now, userId);
    } else {
      db.prepare(`
        UPDATE users SET cookie_115 = ?, cookie_status = ?, updated_at = ? WHERE id = ?
      `).run(cookie, status, now, userId);
    }
  },
  updateUserSaveDir(usernameOrId, saveDir, saveCid = null) {
    const now = new Date().toISOString();
    const isNum = typeof usernameOrId === 'number' || /^\d+$/.test(usernameOrId);
    if (saveCid !== null) {
      if (isNum) {
        db.prepare(`UPDATE users SET save_dir_115 = ?, save_cid_115 = ?, updated_at = ? WHERE id = ?`).run(saveDir, String(saveCid), now, parseInt(usernameOrId, 10));
      } else {
        db.prepare(`UPDATE users SET save_dir_115 = ?, save_cid_115 = ?, updated_at = ? WHERE username = ?`).run(saveDir, String(saveCid), now, usernameOrId);
      }
    } else {
      if (isNum) {
        db.prepare(`UPDATE users SET save_dir_115 = ?, updated_at = ? WHERE id = ?`).run(saveDir, now, parseInt(usernameOrId, 10));
      } else {
        db.prepare(`UPDATE users SET save_dir_115 = ?, updated_at = ? WHERE username = ?`).run(saveDir, now, usernameOrId);
      }
    }
  },
  getAllUsers() {
    return db.prepare("SELECT id, username, emby_user_id, cookie_status, uid_115, save_dir_115, save_cid_115, invite_code, membership_type, membership_expires_at, created_at, updated_at FROM users ORDER BY id DESC").all();
  },

  // 邀请码管理
  createInviteCode(code, type, expiresAt = null) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO invite_codes (code, type, status, expires_at, created_at)
      VALUES (?, ?, 'unused', ?, ?)
    `).run(code, type, expiresAt, now);
  },
  getAllInviteCodes() {
    return db.prepare("SELECT * FROM invite_codes ORDER BY id DESC").all();
  },
  findInviteCode(code) {
    if (!code) return null;
    return db.prepare("SELECT * FROM invite_codes WHERE code = ?").get(code.trim().toUpperCase());
  },
  revokeInviteCode(id) {
    const now = new Date().toISOString();
    db.prepare("UPDATE invite_codes SET status = 'revoked', used_at = ? WHERE id = ?").run(now, id);
  },
  deleteInviteCode(id) {
    db.prepare("DELETE FROM invite_codes WHERE id = ?").run(id);
  },
  useInviteCode(code, userId, membershipType, membershipExpiresAt) {
    const now = new Date().toISOString();
    db.prepare("UPDATE invite_codes SET status = 'used', used_by_user_id = ?, used_at = ? WHERE code = ?").run(userId, now, code.trim().toUpperCase());
    db.prepare("UPDATE users SET invite_code = ?, membership_type = ?, membership_expires_at = ?, updated_at = ? WHERE id = ?").run(code.trim().toUpperCase(), membershipType, membershipExpiresAt || '', now, userId);
  },
  updateUserMembership(userId, membershipType, membershipExpiresAt, code = '') {
    const now = new Date().toISOString();
    db.prepare("UPDATE users SET membership_type = ?, membership_expires_at = ?, invite_code = COALESCE(NULLIF(?, ''), invite_code), updated_at = ? WHERE id = ?").run(membershipType, membershipExpiresAt || '', code, now, userId);
  },
  checkUserMembership(userId) {
    const user = db.prepare("SELECT membership_type, membership_expires_at FROM users WHERE id = ?").get(userId);
    if (!user) return { valid: false, reason: 'user_not_found' };
    // 无会员记录 → 未设置（兼容旧用户，管理员需手动分配）
    if (!user.membership_type) return { valid: false, reason: 'no_membership' };
    // 永久会员（expires_at 为空）
    if (!user.membership_expires_at) return { valid: true, type: user.membership_type, expiresAt: null };
    // 检查是否过期
    const now = new Date();
    const expiresAt = new Date(user.membership_expires_at);
    if (now > expiresAt) return { valid: false, reason: 'expired', expiresAt: user.membership_expires_at };
    return { valid: true, type: user.membership_type, expiresAt: user.membership_expires_at };
  },

  // Cookie 资源池 (管理员/源网盘)
  getAllCookiePool() {
    return db.prepare("SELECT * FROM cookie_pool ORDER BY id DESC").all();
  },
  addCookieToPool(name, cookie, vipExpire = '') {
    const now = new Date().toISOString();
    return db.prepare(`
      INSERT INTO cookie_pool (name, cookie, vip_expire, status, created_at)
      VALUES (?, ?, ?, 'active', ?)
    `).run(name, cookie, vipExpire, now);
  },
  deleteCookieFromPool(id) {
    return db.prepare("DELETE FROM cookie_pool WHERE id = ?").run(id);
  },
  getActiveSourceCookie() {
    return db.prepare("SELECT * FROM cookie_pool WHERE status = 'active' ORDER BY last_used_at ASC LIMIT 1").get();
  },
  updateCookieUsed(id) {
    const now = new Date().toISOString();
    db.prepare("UPDATE cookie_pool SET last_used_at = ? WHERE id = ?").run(now, id);
  },

  // 文件与 SHA1 索引
  findFileBySha1(sha1) {
    return db.prepare("SELECT * FROM files WHERE sha1 = ?").get(sha1);
  },
  findFileByEmbyItemId(itemId) {
    return db.prepare("SELECT * FROM files WHERE emby_item_id = ?").get(itemId);
  },
  recordFileIndex(sha1, filename, filesize, pickcode = '', fileId = '', embyItemId = '', sourcePath = '') {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT sha1, users_json FROM files WHERE sha1 = ?").get(sha1);
    if (!existing) {
      db.prepare(`
        INSERT INTO files (sha1, pickcode, file_id, filename, filesize, source_path, emby_item_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sha1, pickcode, fileId, filename, filesize, sourcePath, embyItemId, now);
    } else {
      db.prepare(`
        UPDATE files SET pickcode = COALESCE(NULLIF(?, ''), pickcode),
                         file_id = COALESCE(NULLIF(?, ''), file_id),
                         emby_item_id = COALESCE(NULLIF(?, ''), emby_item_id)
        WHERE sha1 = ?
      `).run(pickcode, fileId, embyItemId, sha1);
    }
  },
  recordFileUser(sha1, userId) {
    const file = db.prepare("SELECT users_json FROM files WHERE sha1 = ?").get(sha1);
    if (file) {
      let users = [];
      try { users = JSON.parse(file.users_json || '[]'); } catch (e) { }
      if (!users.includes(userId)) {
        users.push(userId);
        db.prepare("UPDATE files SET users_json = ? WHERE sha1 = ?").run(JSON.stringify(users), sha1);
      }
    }
  },
  recordUserFile(userId, sha1, pickcode, fileId = '') {
    if (!userId || !sha1 || !pickcode) return;
    const now = new Date().toISOString();
    try {
      db.prepare(`
        INSERT INTO user_files (user_id, sha1, pickcode, file_id, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, sha1) DO UPDATE SET
          pickcode = excluded.pickcode,
          file_id = COALESCE(NULLIF(excluded.file_id, ''), user_files.file_id)
      `).run(userId, sha1, pickcode, fileId, now);
      // 同时同步更新全局文件用户列表
      this.recordFileUser(sha1, userId);
    } catch (e) {
      console.warn('[DB] recordUserFile 异常:', e.message);
    }
  },
  getUserFile(userId, sha1) {
    if (!userId || !sha1) return null;
    try {
      return db.prepare("SELECT * FROM user_files WHERE user_id = ? AND sha1 = ?").get(userId, sha1);
    } catch (e) {
      return null;
    }
  },
  deleteUserFile(userId, sha1) {
    if (!userId || !sha1) return;
    try {
      db.prepare("DELETE FROM user_files WHERE user_id = ? AND sha1 = ?").run(userId, sha1);
      const file = db.prepare("SELECT users_json FROM files WHERE sha1 = ?").get(sha1);
      if (file && file.users_json) {
        let users = [];
        try { users = JSON.parse(file.users_json); } catch (e) {}
        const filtered = users.filter(id => String(id) !== String(userId));
        db.prepare("UPDATE files SET users_json = ? WHERE sha1 = ?").run(JSON.stringify(filtered), sha1);
      }
    } catch (e) {
      console.warn('[DB] deleteUserFile 异常:', e.message);
    }
  },
  findRecentPeerWithFile(sha1, excludeUserId) {
    if (!sha1) return null;
    // 优先从 user_files 查询持有该文件的其他小号节点
    try {
      const peer = db.prepare(`
        SELECT uf.user_id, uf.pickcode, uf.file_id, u.username, u.cookie_115
        FROM user_files uf
        JOIN users u ON uf.user_id = u.id
        WHERE uf.sha1 = ? AND uf.user_id != ? AND u.cookie_status = 'active' AND u.cookie_115 IS NOT NULL
        ORDER BY uf.id DESC
        LIMIT 1
      `).get(sha1, excludeUserId || 0);
      if (peer) return peer;
    } catch (e) {}

    // 备用从 files.users_json 查询
    const file = db.prepare("SELECT users_json, file_id, pickcode FROM files WHERE sha1 = ?").get(sha1);
    if (!file) return null;
    let users = [];
    try { users = JSON.parse(file.users_json || '[]'); } catch (e) { }
    for (const uid of users) {
      if (String(uid) !== String(excludeUserId)) {
        const user = db.prepare("SELECT id, username, cookie_115 FROM users WHERE id = ? AND cookie_status = 'active'").get(uid);
        if (user && user.cookie_115) {
          return {
            user_id: user.id,
            username: user.username,
            cookie_115: user.cookie_115,
            file_id: file.file_id,
            pickcode: file.pickcode
          };
        }
      }
    }
    return null;
  },
  updateFilePlayback(sha1) {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE files SET play_count = play_count + 1, last_played_at = ? WHERE sha1 = ?
    `).run(now, sha1);
  },
  getAllIndexedFiles(limit = 100) {
    return db.prepare("SELECT * FROM files ORDER BY COALESCE(last_played_at, created_at) DESC, created_at DESC LIMIT ?").all(limit);
  },

  // 播放日志
  logPlayback(itemId, itemName, userId, userIp, speedMode, redirectUrl) {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO playback_logs (item_id, item_name, user_id, user_ip, speed_mode, redirect_url, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, itemName, String(userId || ''), userIp, speedMode, redirectUrl, now);
  },
  getRecentLogs(limit = 50) {
    return db.prepare("SELECT * FROM playback_logs ORDER BY id DESC LIMIT ?").all(limit);
  },

  // 系统统计概览
  getStats() {
    const totalFiles = db.prepare("SELECT COUNT(*) as cnt FROM files").get().cnt;
    const totalUsers = db.prepare("SELECT COUNT(*) as cnt FROM users").get().cnt;
    const totalPool = db.prepare("SELECT COUNT(*) as cnt FROM cookie_pool WHERE status = 'active'").get().cnt;
    const totalPlays = db.prepare("SELECT COUNT(*) as cnt FROM playback_logs").get().cnt;
    const todayPlays = db.prepare("SELECT COUNT(*) as cnt FROM playback_logs WHERE created_at >= date('now')").get().cnt;
    return {
      totalFiles,
      totalUsers,
      totalPool,
      totalPlays,
      todayPlays
    };
  }
};

module.exports = {
  db,
  dbService
};
