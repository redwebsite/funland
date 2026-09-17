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
  `);

  // 默认系统配置检查
  const checkSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
  const setSetting = db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)");

  const defaults = [
    { key: 'emby_upstream_url', value: config.emby.upstreamUrl },
    { key: 'emby_api_key', value: config.emby.apiKey },
    { key: 'acceleration_mode', value: 'PRO' }, // 'PRO' (3级智能加速) 或 'NORMAL' (仅源盘直链)
    { key: 'cache_ttl_seconds', value: String(config.cache.ttlSeconds) }
  ];

  for (const item of defaults) {
    const existing = checkSetting.get(item.key);
    if (!existing) {
      setSetting.run(item.key, item.value, new Date().toISOString());
    }
  }

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
  findUserByUsername(username) {
    return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  },
  findUserById(id) {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  },
  createUser(username, passwordHash, embyUserId = '') {
    const now = new Date().toISOString();
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, emby_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, passwordHash, embyUserId, now, now);
    return result.lastInsertRowid;
  },
  updateUser115Cookie(userId, cookie, status = 'active') {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE users SET cookie_115 = ?, cookie_status = ?, updated_at = ? WHERE id = ?
    `).run(cookie, status, now, userId);
  },
  getAllUsers() {
    return db.prepare("SELECT id, username, emby_user_id, cookie_status, created_at, updated_at FROM users ORDER BY id DESC").all();
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
  findRecentPeerWithFile(sha1, excludeUserId) {
    const file = db.prepare("SELECT users_json FROM files WHERE sha1 = ?").get(sha1);
    if (!file) return null;
    let users = [];
    try { users = JSON.parse(file.users_json || '[]'); } catch (e) { }
    for (const uid of users) {
      if (String(uid) !== String(excludeUserId)) {
        const user = db.prepare("SELECT id, username, cookie_115 FROM users WHERE id = ? AND cookie_status = 'active'").get(uid);
        if (user && user.cookie_115) {
          return user;
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
    return db.prepare("SELECT * FROM files ORDER BY last_played_at DESC, created_at DESC LIMIT ?").all(limit);
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
