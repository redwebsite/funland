const express = require('express');
const { dbService } = require('../db/database');
const openApi115 = require('../modules/openapi-115');
const embyApi = require('../modules/emby-api');
const config = require('../config');

const router = express.Router();

// 1. 公开系统连接信息与配置引导
router.get('/info', (req, res) => {
  res.json({
    success: true,
    data: {
      domain: config.domain,
      ports: {
        portal: config.ports.portal,
        admin: config.ports.admin,
        emby: config.ports.emby
      },
      embyServerAddress: `http://emby.${config.domain}:${config.ports.emby}`,
      embyHttpsAddress: `https://emby.${config.domain}`,
      guides: [
        {
          client: 'Infuse (iOS / Mac / Apple TV)',
          steps: [
            `在 Infuse 中添加媒体库，选择【Emby】协议`,
            `服务器地址输入: emby.${config.domain}，端口填写: 443 (或 http 输入端口 ${config.ports.emby})`,
            `输入你的 Emby 账号密码登录`,
            `享受 115 满速 4K 原画直链串流！`
          ]
        },
        {
          client: 'VidHub (iOS / Mac / Apple TV)',
          steps: [
            `打开 VidHub，点击【添加媒体源】-> 选择【Emby】`,
            `服务器填写: emby.${config.domain}，勾选 HTTPS`,
            `登录你的 Emby 账号即可自动解析 115 直链`
          ]
        },
        {
          client: 'Emby 官方客户端 (Android / iOS / 网页)',
          steps: [
            `服务器地址填写: emby.${config.domain}`,
            `端口填写: 443 (若开启了 SSL) 或 ${config.ports.emby}`,
            `登录后播放视频即可触发 302 满速直链加速`
          ]
        }
      ]
    }
  });
});

// 1.1 注册状态与名额查询
router.get('/user/reg-info', (req, res) => {
  const allowReg = dbService.getSetting('allow_registration', 'true') === 'true';
  const maxLimit = parseInt(dbService.getSetting('max_users_limit', '200'), 10);
  const currentCount = dbService.getUserCount();
  const remaining = Math.max(0, maxLimit - currentCount);

  res.json({
    success: true,
    data: {
      allowed: allowReg && remaining > 0,
      isSwitchOpen: allowReg,
      currentUsers: currentCount,
      maxUsersLimit: maxLimit,
      remainingSlots: remaining,
      statusText: !allowReg 
        ? '管理员已关闭新用户注册' 
        : (remaining <= 0 ? `注册名额已满（上限 ${maxLimit} 人）` : `开放注册中（剩余名额: ${remaining}/${maxLimit}）`)
    }
  });
});

// 1.2 新用户自主注册接口
router.post('/user/register', async (req, res) => {
  const allowReg = dbService.getSetting('allow_registration', 'true') === 'true';
  const maxLimit = parseInt(dbService.getSetting('max_users_limit', '200'), 10);
  const currentCount = dbService.getUserCount();

  if (!allowReg) {
    return res.status(403).json({ success: false, error: '管理员已暂停新用户注册' });
  }

  if (currentCount >= maxLimit) {
    return res.status(403).json({ success: false, error: `注册名额已满！系统上限支持 ${maxLimit} 名用户` });
  }

  const { username, password } = req.body;
  if (!username || !password || username.trim().length < 3 || password.trim().length < 6) {
    return res.status(400).json({ success: false, error: '用户名须至少3位，密码须至少6位' });
  }

  const cleanUsername = username.trim();
  const cleanPassword = password.trim();

  const existing = dbService.findUserByUsername(cleanUsername);
  if (existing) {
    return res.status(400).json({ success: false, error: '该用户名已被占用' });
  }

  // 检查是否开启了 Emby 用户自动同步 (联动 Emby 模式)
  const syncEmby = dbService.getSetting('emby_sync_user', 'true') === 'true';
  const templateUserId = dbService.getSetting('emby_template_user_id', '');
  let embyUserId = '';

  if (syncEmby) {
    try {
      const embyResult = await embyApi.createEmbyUser(cleanUsername, cleanPassword, templateUserId);
      embyUserId = embyResult.embyUserId || '';
      console.log(`🎬 [Emby Sync] 成功为用户 ${cleanUsername} 创建 Emby 账号 (ID: ${embyUserId})`);
    } catch (err) {
      console.error('[User Register] 同步创建 Emby 账号失败:', err.message);
      return res.status(400).json({
        success: false,
        error: `无法在 Emby 服务器创建账号: ${err.message}`
      });
    }
  }

  const crypto = require('crypto');
  const passwordHash = crypto.createHash('sha256').update(cleanPassword).digest('hex');
  const newId = dbService.createUser(cleanUsername, passwordHash, embyUserId, cleanPassword);

  res.json({
    success: true,
    msg: syncEmby ? '注册成功！已在 Emby 同步创建账号，请登录并绑定 115 账号' : '注册成功！请登录并绑定您的 115 账号',
    data: {
      id: newId,
      username: cleanUsername,
      embyUserId,
      cookieStatus: 'unbound'
    }
  });
});

// 1.3 用户登录接口 (支持本地密码与 Emby 上游密码穿透认证，全面兼容任意长度及无密码 Emby 用户)
router.post('/user/login', async (req, res) => {
  const { username } = req.body;
  const rawPassword = req.body.password != null ? String(req.body.password) : '';
  if (!username || !username.trim()) {
    return res.status(400).json({ success: false, error: '请输入用户名' });
  }

  const cleanUsername = username.trim();
  const cleanPassword = rawPassword;
  const crypto = require('crypto');
  const passwordHash = crypto.createHash('sha256').update(cleanPassword).digest('hex');

  let user = dbService.findUserByUsername(cleanUsername);

  // 场景 A: 本地存在该用户
  if (user) {
    if (user.cookie_status === 'disabled') {
      return res.status(403).json({ success: false, error: '该用户已被管理员停用' });
    }

    // 1. 若本地已有密码哈希且完全匹配，直接通过
    if (user.password_hash && user.password_hash === passwordHash) {
      if (!user.plain_password) {
        try { dbService.updateUserPlainPassword(user.id, cleanPassword); } catch (e) {}
      }
    } else {
      // 2. 本地尚无密码哈希 (从 Emby 同步导入的老用户) 或密码不匹配，尝试向 Emby 上游发起穿透认证
      const embyAuth = await embyApi.authenticateUser(cleanUsername, cleanPassword);
      if (embyAuth.success) {
        // 验证通过：在本地沉淀该密码哈希与明文，补齐关联
        try {
          dbService.updateUserPassword(user.id, passwordHash, cleanPassword);
          if (!user.emby_user_id && embyAuth.embyUserId) {
            dbService.updateEmbyUserId(user.id, embyAuth.embyUserId);
          }
        } catch (e) {}
      } else {
        return res.status(401).json({ success: false, error: '用户名或密码错误' });
      }
    }
  } else {
    // 场景 B: 本地尚未记录该用户，尝试验证是否为 Emby 现有老用户
    const embyAuth = await embyApi.authenticateUser(cleanUsername, cleanPassword);
    if (embyAuth.success) {
      // 自动在 Funland 为该 Emby 用户建档开户
      const newId = dbService.createUser(cleanUsername, passwordHash, embyAuth.embyUserId, cleanPassword);
      user = dbService.findUserById(newId);
    } else {
      return res.status(401).json({ success: false, error: '用户名或密码错误' });
    }
  }

  res.json({
    success: true,
    msg: '登录成功',
    data: {
      id: user.id,
      username: user.username,
      cookieStatus: user.cookie_status || 'unbound',
      has115Cookie: Boolean(user.cookie_115)
    }
  });
});


// 2. 115 OpenAPI 扫码：创建扫码登录会话
router.post('/115/qrcode/token', async (req, res) => {
  const result = await openApi115.createQrSession();
  res.json(result);
});

// 3. 115 OpenAPI 扫码：轮询状态
router.get('/115/qrcode/status', async (req, res) => {
  const { uid, time, sign, username } = req.query;
  if (!uid || !time || !sign) {
    return res.status(400).json({ status: 'error', error: '缺少 uid / time / sign 参数' });
  }

  const result = await openApi115.checkQrStatus(uid, time, sign);

  // 如果登录成功，并且附带了用户名，自动绑定该 Cookie 到用户
  if (result.status === 'confirmed' && result.cookie) {
    const targetUsername = username || 'guest_user';
    let user = dbService.findUserByUsername(targetUsername);
    if (!user) {
      const uid = dbService.createUser(targetUsername, 'default_pwd');
      user = dbService.findUserById(uid);
    }
    const check = await openApi115.validateCookie(result.cookie);
    const uid115 = (check && check.userId) ? check.userId : '';
    dbService.updateUser115Cookie(user.id, result.cookie, 'active', uid115);
    result.boundUser = targetUsername;
    result.uid115 = uid115;
  }

  res.json(result);
});

// 4. 手动绑定 115 Cookie
router.post('/user/bind-cookie', async (req, res) => {
  const { username, cookie } = req.body;
  if (!cookie) {
    return res.status(400).json({ success: false, error: 'Cookie 不能为空' });
  }

  const check = await openApi115.validateCookie(cookie);
  if (!check.valid) {
    return res.status(400).json({ success: false, error: `Cookie 无效: ${check.error}` });
  }

  const targetUsername = username || 'default_user';
  let user = dbService.findUserByUsername(targetUsername);
  if (!user) {
    const id = dbService.createUser(targetUsername, 'default_pwd');
    user = dbService.findUserById(id);
  }

  const uid115 = check.userId || '';
  dbService.updateUser115Cookie(user.id, cookie, 'active', uid115);

  res.json({
    success: true,
    msg: `成功绑定 115 账号: ${check.username}！`,
    data: {
      ...check,
      uid115,
      saveDir: user.save_dir_115 || '/EmbyCache'
    }
  });
});

// 5. 校验用户网盘绑定状态与获取配置
router.get('/user/status', async (req, res) => {
  const username = req.query.username || 'default_user';
  const user = dbService.findUserByUsername(username);

  if (!user || !user.cookie_115) {
    return res.json({
      success: true,
      bound: false,
      msg: '尚未绑定 115 网盘'
    });
  }

  const check = await openApi115.validateCookie(user.cookie_115);
  const uid115 = user.uid_115 || (check && check.userId) || '';
  if (!user.uid_115 && check.userId) {
    dbService.updateUser115Cookie(user.id, user.cookie_115, 'active', check.userId);
  }

  const isBound = Boolean(check.valid || (user.cookie_status === 'active' && user.cookie_115));

  res.json({
    success: true,
    bound: isBound,
    cookieStatus: user.cookie_status,
    uid: uid115 || '594679508',
    saveDir: user.save_dir_115 || '/EmbyCache',
    saveCid: user.save_cid_115 || '',
    data: check
  });
});

// 6. 保存用户网盘设置 (例如秒存文件夹与对应 CID)
router.post('/user/settings', (req, res) => {
  const { username, saveDir, saveCid } = req.body || {};
  if (!username) {
    return res.status(400).json({ success: false, error: '用户名不能为空' });
  }
  const user = dbService.findUserByUsername(username.trim());
  if (!user) {
    return res.status(404).json({ success: false, error: '未找到指定用户' });
  }

  let cleanDir = (saveDir || '/EmbyCache').trim();
  if (!cleanDir.startsWith('/')) cleanDir = '/' + cleanDir;

  dbService.updateUserSaveDir(user.id, cleanDir, typeof saveCid !== 'undefined' ? saveCid : null);

  res.json({
    success: true,
    msg: '115 秒存文件夹配置保存成功！',
    saveDir: cleanDir,
    saveCid: typeof saveCid !== 'undefined' ? String(saveCid) : (user.save_cid_115 || '')
  });
});

// 7. 获取用户的 115 网盘文件夹列表 (供前端文件夹选择器使用)
router.get('/115/folders', async (req, res) => {
  const username = req.query.username || 'default_user';
  const cid = req.query.cid || '0';
  const user = dbService.findUserByUsername(username.trim());

  if (!user || !user.cookie_115) {
    return res.status(400).json({ success: false, error: '用户尚未绑定 115 网盘' });
  }

  const result = await openApi115.getDirectories(user.cookie_115, cid);
  res.json(result);
});

// 8. 用户在 115 网盘中创建新文件夹
router.post('/115/folders/create', async (req, res) => {
  const { username, pid, name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: '文件夹名称不能为空' });
  }
  const user = dbService.findUserByUsername((username || 'default_user').trim());
  if (!user || !user.cookie_115) {
    return res.status(400).json({ success: false, error: '用户尚未绑定 115 网盘' });
  }

  const result = await openApi115.createDirectory(user.cookie_115, pid || '0', name.trim());
  res.json(result);
});

module.exports = router;
