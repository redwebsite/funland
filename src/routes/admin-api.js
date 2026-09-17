const express = require('express');
const { dbService } = require('../db/database');
const cacheScheduler = require('../modules/cache-scheduler');
const openApi115 = require('../modules/openapi-115');
const config = require('../config');

const router = express.Router();

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
      maxUsersLimit: parseInt(dbService.getSetting('max_users_limit', '200'), 10)
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

// 5. 添加账号至 Cookie 资源池
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

// 12. 用户列表
router.get('/users', (req, res) => {
  const users = dbService.getAllUsers();
  res.json({ success: true, data: users });
});

// 13. 切换用户状态 (封禁/解封)
router.post('/users/:id/toggle', (req, res) => {
  const newStatus = dbService.toggleUserStatus(req.params.id);
  if (!newStatus) return res.status(404).json({ success: false, error: '用户不存在' });
  res.json({ success: true, msg: `用户状态已切换为: ${newStatus}`, newStatus });
});

// 14. 删除用户
router.delete('/users/:id', (req, res) => {
  dbService.deleteUser(req.params.id);
  res.json({ success: true, msg: '用户已删除' });
});

module.exports = router;
