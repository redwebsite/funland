const express = require('express');
const { dbService } = require('../db/database');
const cacheScheduler = require('../modules/cache-scheduler');
const openApi115 = require('../modules/openapi-115');
const embyApi = require('../modules/emby-api');
const config = require('../config');

const crypto = require('crypto');

const router = express.Router();

function generateToken(username) {
  const payload = `${username}:${Date.now()}`;
  const signature = crypto.createHmac('sha256', config.admin.jwtSecret).update(payload).digest('hex');
  return Buffer.from(`${payload}:${signature}`).toString('base64');
}

function verifyToken(token) {
  if (!token) return false;
  try {
    const raw = Buffer.from(token, 'base64').toString('utf8');
    const [username, timestamp, signature] = raw.split(':');
    if (!username || !timestamp || !signature) return false;
    if (Date.now() - parseInt(timestamp, 10) > 7 * 24 * 3600 * 1000) return false;
    const expected = crypto.createHmac('sha256', config.admin.jwtSecret).update(`${username}:${timestamp}`).digest('hex');
    return signature === expected && username === config.admin.username;
  } catch (e) {
    return false;
  }
}

// 0. 管理员登录
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '账号和密码不能为空' });
  }

  if (username === config.admin.username && password === config.admin.password) {
    const token = generateToken(username);
    return res.json({
      success: true,
      token,
      username: config.admin.username,
      msg: '登录成功'
    });
  }

  return res.status(401).json({ success: false, error: '管理员账号或密码错误' });
});

// 0.1 验证登录态
router.get('/auth-status', (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : (req.query.token || '');
  const isValid = verifyToken(token);
  res.json({
    success: true,
    authenticated: isValid,
    username: isValid ? config.admin.username : null
  });
});

// 管理后台接口全局禁用任何缓存，杜绝 304 问题，确保数据实时刷新
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// 权限拦截中间件（除 login / auth-status 外均需有效 token）
router.use((req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : (req.query.token || '');
  if (!verifyToken(token)) {
    return res.status(401).json({ success: false, error: '请先登录管理员账号' });
  }
  next();
});

// 1. 系统数据统计
router.get('/stats', (req, res) => {
  const dbStats = dbService.getStats();
  const cacheStats = cacheScheduler.getStats();
  res.json({
    success: true,
    data: {
      ...dbStats,
      cache: cacheStats,
      domain: config.domain,
      ports: config.ports,
      accelerationMode: dbService.getSetting('acceleration_mode', 'PRO'),
      upstreamUrl: dbService.getSetting('emby_upstream_url', config.emby.upstreamUrl),
      allowRegistration: dbService.getSetting('allow_registration', 'true') === 'true',
      maxUsersLimit: parseInt(dbService.getSetting('max_users_limit', '200'), 10),
      allowMasterDirectFallback: dbService.getSetting('allow_master_direct_fallback', 'false') === 'true',
      allowMasterForGuests: dbService.getSetting('allow_master_for_guests', 'false') === 'true'
    }
  });
});

// 2. 获取配置
router.get('/settings', (req, res) => {
  const settings = dbService.getAllSettings();
  const map = {};
  settings.forEach(s => { map[s.key] = s.value; });
  res.json({ success: true, data: map });
});

// 3. 更新配置
router.post('/settings', (req, res) => {
  const { settings } = req.body;
  if (settings && typeof settings === 'object') {
    for (const [k, v] of Object.entries(settings)) {
      dbService.setSetting(k, v);
    }
    return res.json({ success: true, msg: '配置已更新' });
  }
  res.status(400).json({ success: false, error: '无效请求' });
});

// 4. Cookie 资源池列表
router.get('/cookie-pool', (req, res) => {
  const pool = dbService.getAllCookiePool();
  // 脱敏处理 Cookie 展示
  const safePool = pool.map(item => ({
    ...item,
    cookiePreview: item.cookie.length > 24 ? `${item.cookie.substring(0, 10)}...${item.cookie.substring(item.cookie.length - 8)}` : '***'
  }));
  res.json({ success: true, data: safePool });
});

// 5. 添加账号至 Cookie 资源池 (手动粘贴 Cookie)
router.post('/cookie-pool', async (req, res) => {
  const { name, cookie } = req.body;
  if (!cookie || !name) {
    return res.status(400).json({ success: false, error: '名称与 Cookie 均不能为空' });
  }

  // 验证 Cookie 有效性
  const check = await openApi115.validateCookie(cookie);
  if (!check.valid) {
    return res.status(400).json({ success: false, error: `Cookie 验证失败: ${check.error}` });
  }

  try {
    const vipInfo = check.isVip ? `VIP到期: ${check.vipExpire}` : '普通账号';
    dbService.addCookieToPool(name, cookie, vipInfo);
    res.json({
      success: true,
      msg: `添加成功！115用户: ${check.username} (${vipInfo})`
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 5.1 扫码添加源网盘至 Cookie 资源池 - 创建扫码会话
router.post('/cookie-pool/qr-session', async (req, res) => {
  const session = await openApi115.createQrSession();
  res.json(session);
});

// 5.2 扫码添加源网盘至 Cookie 资源池 - 轮询扫码状态
router.get('/cookie-pool/qr-status', async (req, res) => {
  const { uid, time, sign, name } = req.query;
  if (!uid || !time || !sign) {
    return res.status(400).json({ success: false, error: '缺少扫码参数' });
  }
  const result = await openApi115.checkQrStatus(uid, time, sign);
  if (result.status === 'confirmed' && result.cookie) {
    const check = await openApi115.validateCookie(result.cookie);
    const vipInfo = check.isVip ? `VIP到期: ${check.vipExpire}` : '普通账号';
    const poolName = name ? name.trim() : `源盘_${check.username || '115'}`;
    dbService.addCookieToPool(poolName, result.cookie, vipInfo);
    return res.json({
      ...result,
      saved: true,
      poolName,
      vipInfo,
      username: check.username
    });
  }
  res.json(result);
});

// 6. 删除 Cookie 资源池账号
router.delete('/cookie-pool/:id', (req, res) => {
  dbService.deleteCookieFromPool(req.params.id);
  res.json({ success: true, msg: '账号已从资源池移除' });
});

// 7. 缓存列表与命中监控
router.get('/cache', (req, res) => {
  const list = cacheScheduler.listKeys();
  const stats = cacheScheduler.getStats();
  res.json({
    success: true,
    data: {
      stats,
      items: list
    }
  });
});

// 8. 清空缓存
router.post('/cache/flush', (req, res) => {
  cacheScheduler.flush();
  res.json({ success: true, msg: '30分钟滑动缓存已全部清空' });
});

// 8.1 预热或写入测试直链缓存
router.post('/cache/warm', (req, res) => {
  const { itemId, directUrl, userId = 'anonymous', ttl } = req.body;
  if (!itemId || !directUrl) {
    return res.status(400).json({ success: false, error: 'itemId 与 directUrl 必填' });
  }
  const key = cacheScheduler.makeKey('stream:direct', itemId, userId);
  cacheScheduler.set(key, directUrl, ttl ? parseInt(ttl, 10) : config.cache.ttlSeconds);
  res.json({ success: true, msg: `直链已预热至 30 分钟滑动缓存 (Key: ${key})` });
});

// 9. 索引文件列表
router.get('/files', (req, res) => {
  const files = dbService.getAllIndexedFiles(100);
  res.json({ success: true, data: files });
});

// 10. 录入或导入文件 SHA1 索引
router.post('/files', (req, res) => {
  const { sha1, filename, filesize, pickcode, fileId, embyItemId } = req.body;
  if (!sha1 || !filename) {
    return res.status(400).json({ success: false, error: 'SHA1 与文件名必填' });
  }
  dbService.recordFileIndex(sha1, filename, parseInt(filesize || '0', 10), pickcode, fileId, embyItemId);
  res.json({ success: true, msg: '文件索引已登记' });
});

// 11. 播放日志
router.get('/logs', (req, res) => {
  const logs = dbService.getRecentLogs(100);
  res.json({ success: true, data: logs });
});


// 12. 用户列表 (实时核对上游 Emby 账号存活状态)
router.get('/users', async (req, res) => {
  let users = dbService.getAllUsers();

  // 尝试与上游 Emby 服务器实时核对用户存活状态
  try {
    const embyUsers = await embyApi.getEmbyUsers();
    if (Array.isArray(embyUsers)) {
      const embyIdMap = new Map();
      const embyNameMap = new Map();
      embyUsers.forEach(u => {
        if (u && u.id) {
          const rawId = String(u.id).trim();
          embyIdMap.set(rawId.toLowerCase().replace(/-/g, ''), rawId);
        }
        if (u && u.name) {
          embyNameMap.set(String(u.name).trim().toLowerCase(), u);
        }
      });

      for (const u of users) {
        if (u.emby_user_id) {
          const normId = String(u.emby_user_id).trim().toLowerCase().replace(/-/g, '');
          if (!embyIdMap.has(normId)) {
            // Emby 中该 ID 已经不存在，检查是否被重新以同名创建
            const nameMatch = u.username ? embyNameMap.get(String(u.username).trim().toLowerCase()) : null;
            if (nameMatch) {
              dbService.updateEmbyUserId(u.id, nameMatch.id);
              u.emby_user_id = nameMatch.id;
            } else {
              // Emby 端已删除该用户，自动置空本地关联（状态变为未关联）
              dbService.updateEmbyUserId(u.id, '');
              u.emby_user_id = '';
            }
          }
        } else if (u.username) {
          // 本地尚未关联，但如果 Emby 端存在同名用户，则自动关联
          const nameMatch = embyNameMap.get(String(u.username).trim().toLowerCase());
          if (nameMatch) {
            dbService.updateEmbyUserId(u.id, nameMatch.id);
            u.emby_user_id = nameMatch.id;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Admin API] 刷新用户时核对 Emby 状态跳过:', err.message);
  }

  res.json({ success: true, data: users });
});

// 13. 切换用户状态 (封禁/解封)
router.post('/users/:id/toggle', (req, res) => {
  const newStatus = dbService.toggleUserStatus(req.params.id);
  if (!newStatus) return res.status(404).json({ success: false, error: '用户不存在' });
  res.json({ success: true, msg: `用户状态已切换为: ${newStatus}`, newStatus });
});

// 14. 删除用户 (默认同步删除 Emby 服务端的账号)
router.delete('/users/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ success: false, error: '用户 ID 参数无效' });
  }

  const user = dbService.findUserById(id);
  let embyDeleted = false;

  if (user) {
    // 默认同步删除 Emby 账号 (除非显式指定 deleteEmby=false)
    const shouldDeleteEmby = req.query.deleteEmby !== 'false';
    if (shouldDeleteEmby) {
      let targetEmbyId = user.emby_user_id;

      // 如果本地没有记录 emby_user_id，尝试通过用户名在上游 Emby 查找同名账号删除
      if (!targetEmbyId) {
        try {
          const embyUsers = await embyApi.getEmbyUsers();
          const match = embyUsers.find(u => u.name.toLowerCase() === user.username.toLowerCase());
          if (match && !match.isAdmin) {
            targetEmbyId = match.id;
          }
        } catch (e) {}
      }

      if (targetEmbyId) {
        try {
          embyDeleted = await embyApi.deleteEmbyUser(targetEmbyId);
          console.log(`🗑️ [Emby User] 成功同步删除 Emby 用户: ${user.username} (ID: ${targetEmbyId})`);
        } catch (err) {
          console.warn(`[Emby User] 同步删除 Emby 用户失败:`, err.message);
        }
      }
    }
  }

  dbService.deleteUser(id);
  res.json({
    success: true,
    msg: embyDeleted 
      ? `用户 "${user ? user.username : id}" 及其 Emby 账号已同步彻底删除！` 
      : `用户 #${id} 已成功删除`,
    embyDeleted
  });
});

// 15. 获取上游 Emby 用户列表（供后台选择模板用户）
router.get('/emby-users', async (req, res) => {
  try {
    const users = await embyApi.getEmbyUsers();
    res.json({ success: true, data: users });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 16. 手动补同步已有用户至 Emby (直接提取用户注册时设置的密码)
router.post('/users/:id/sync-emby', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(400).json({ success: false, error: '无效用户 ID' });
  }

  const user = dbService.findUserById(id);
  if (!user) {
    return res.status(404).json({ success: false, error: '用户不存在' });
  }

  const { initialPassword } = req.body || {};
  const syncPassword = user.plain_password || initialPassword || '12345678';
  const templateUserId = dbService.getSetting('emby_template_user_id', '');

  try {
    const embyResult = await embyApi.createEmbyUser(
      user.username,
      syncPassword,
      templateUserId
    );
    dbService.updateEmbyUserId(id, embyResult.embyUserId);
    res.json({
      success: true,
      msg: `已成功在 Emby 创建用户 "${user.username}" 并同步注册密码及模板权限！`,
      embyUserId: embyResult.embyUserId
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 17. 一键全量同步 Emby 用户至 Funland（自动排除模板用户，支持智能防重关联）
router.post('/sync-emby-users', async (req, res) => {
  try {
    const embyUsers = await embyApi.getEmbyUsers();
    if (!Array.isArray(embyUsers) || embyUsers.length === 0) {
      return res.status(400).json({ success: false, error: '未能从 Emby 获取到任何有效用户，请检查上游地址与 API Key' });
    }

    const templateUserId = dbService.getSetting('emby_template_user_id', '');
    const templateUserName = dbService.getSetting('emby_template_user_name', '');

    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const createdUsers = [];
    const updatedUsers = [];
    let skippedTemplateName = '';

    for (const u of embyUsers) {
      // 1. 自动过滤选中的模板用户 (Template User)
      if ((templateUserId && u.id === templateUserId) || 
          (templateUserName && (u.name === templateUserName || templateUserName.startsWith(u.name)))) {
        skippedTemplateName = u.name;
        skippedCount++;
        continue;
      }

      // 2. 检查 Funland 本地是否已存在该用户
      const existing = dbService.findUserByUsername(u.name) || dbService.findUserByEmbyUserId(u.id);
      if (existing) {
        // 如果未关联 emby_user_id，自动补齐关联
        if (!existing.emby_user_id || existing.emby_user_id !== u.id) {
          dbService.updateEmbyUserId(existing.id, u.id);
        }
        updatedCount++;
        updatedUsers.push(u.name);
      } else {
        // 3. 自动在 Funland 本地建档（密码哈希留空，支持 Emby 密码穿透首次登录）
        dbService.createUser(u.name, '', u.id, '');
        createdCount++;
        createdUsers.push(u.name);
      }
    }

    res.json({
      success: true,
      summary: {
        total: embyUsers.length,
        createdCount,
        updatedCount,
        skippedCount,
        skippedTemplate: skippedTemplateName || templateUserName || templateUserId || null,
        createdUsers,
        updatedUsers
      },
      msg: `同步完成！检测到 ${embyUsers.length} 名 Emby 用户：成功新增导入 ${createdCount} 人，自动关联已有 ${updatedCount} 人${skippedCount > 0 ? `，已自动跳过模板用户 (${skippedTemplateName || 'Template'})` : ''}。`
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;

