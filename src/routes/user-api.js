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
  const inviteCodeRequired = dbService.getSetting('invite_code_required', 'true') === 'true';

  res.json({
    success: true,
    data: {
      allowed: allowReg && remaining > 0,
      isSwitchOpen: allowReg,
      currentUsers: currentCount,
      maxUsersLimit: maxLimit,
      remainingSlots: remaining,
      inviteCodeRequired,
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

  const rawUsername = req.body && req.body.username != null ? String(req.body.username).trim() : '';
  const rawPassword = req.body && req.body.password != null ? String(req.body.password).trim() : '';
  const rawInviteCode = req.body && req.body.inviteCode != null ? String(req.body.inviteCode).trim().toUpperCase() : '';

  if (!rawUsername) {
    return res.status(400).json({ success: false, error: '请输入有效的用户名' });
  }
  if (!rawPassword || rawPassword.length < 6) {
    return res.status(400).json({ success: false, error: '新账号注册时密码须至少6位' });
  }

  // ── 邀请码验证 ──────────────────────────────
  const inviteRequired = dbService.getSetting('invite_code_required', 'true') === 'true';
  let membershipType = '';
  let membershipExpiresAt = '';
  let usedCode = '';
  const MEMBERSHIP_DAYS = { trial_7d: 7, monthly: 30, quarterly: 90, yearly: 365 };

  if (inviteRequired) {
    if (!rawInviteCode) {
      return res.status(400).json({ success: false, error: '请输入邀请码' });
    }

    // 先检查通用邀请码
    const universalCode = dbService.getSetting('universal_invite_code', '');
    if (universalCode && rawInviteCode === universalCode.trim().toUpperCase()) {
      // 通用码 → 季卡（90天）
      membershipType = 'quarterly';
      const exp = new Date();
      exp.setDate(exp.getDate() + 90);
      membershipExpiresAt = exp.toISOString();
      usedCode = rawInviteCode;
    } else {
      // 查一次性邀请码表
      const codeRow = dbService.findInviteCode(rawInviteCode);
      if (!codeRow) {
        return res.status(400).json({ success: false, error: '邀请码无效，请检查后重试' });
      }
      if (codeRow.status === 'used') {
        return res.status(400).json({ success: false, error: '该邀请码已被使用' });
      }
      if (codeRow.status === 'revoked') {
        return res.status(400).json({ success: false, error: '该邀请码已被管理员吊销' });
      }
      // 检查码本身的有效期（即管理员生成后多少天内需被使用）
      if (codeRow.expires_at && new Date() > new Date(codeRow.expires_at)) {
        return res.status(400).json({ success: false, error: '该邀请码已过期，请联系管理员获取新码' });
      }
      // 计算会员到期时间
      const days = MEMBERSHIP_DAYS[codeRow.type] || 30;
      membershipType = codeRow.type;
      const exp = new Date();
      exp.setDate(exp.getDate() + days);
      membershipExpiresAt = exp.toISOString();
      usedCode = rawInviteCode;
    }
  }
  // ────────────────────────────────────────────

  const cleanUsername = rawUsername;
  const cleanPassword = rawPassword;

  const existing = dbService.findUserByUsername(cleanUsername);
  if (existing) {
    return res.status(400).json({ success: false, error: '该用户名已被占用' });
  }

  // 检查是否开启了 Emby 用户自动同步
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

  // 写入会员信息
  if (membershipType) {
    if (usedCode && usedCode !== (dbService.getSetting('universal_invite_code', '').trim().toUpperCase())) {
      // 一次性邀请码：标记已用并写入用户
      dbService.useInviteCode(usedCode, newId, membershipType, membershipExpiresAt);
    } else {
      // 通用码：直接写用户会员字段
      dbService.updateUserMembership(newId, membershipType, membershipExpiresAt, usedCode);
    }
  }

  const typeLabels = { trial_7d: '7天体验卡', monthly: '月卡', quarterly: '季卡', yearly: '年卡' };
  const typeLabel = typeLabels[membershipType] || '';

  res.json({
    success: true,
    msg: syncEmby
      ? `注册成功！已在 Emby 同步创建账号${typeLabel ? `，已激活${typeLabel}` : ''}，请登录并绑定 115 账号`
      : `注册成功！${typeLabel ? `已激活${typeLabel}，` : ''}请登录并绑定您的 115 账号`,
    data: {
      id: newId,
      username: cleanUsername,
      embyUserId,
      cookieStatus: 'unbound',
      membershipType,
      membershipExpiresAt
    }
  });
});

// 1.3 用户登录接口 (支持本地密码与 Emby 上游密码穿透认证，全面兼容任意长度及无密码 Emby 用户)
router.post('/user/login', async (req, res) => {
  const rawUsername = req.body && req.body.username != null ? String(req.body.username).trim() : '';
  const rawPassword = req.body && req.body.password != null ? String(req.body.password) : '';
  if (!rawUsername) {
    return res.status(400).json({ success: false, error: '请输入用户名' });
  }

  const cleanUsername = rawUsername;
  const cleanPassword = rawPassword;
  const crypto = require('crypto');
  const passwordHash = crypto.createHash('sha256').update(cleanPassword).digest('hex');

  // 支持输入 Emby 用户名或 Emby 专属 UserId
  let user = dbService.findUserByUsername(cleanUsername) || dbService.findUserByEmbyUserId(cleanUsername);

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
      const authUsername = user.username || cleanUsername;
      const embyAuth = await embyApi.authenticateUser(authUsername, cleanPassword);
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
      const officialName = embyAuth.embyUser?.Name || cleanUsername;
      const newId = dbService.createUser(officialName, passwordHash, embyAuth.embyUserId, cleanPassword);
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
      has115Cookie: Boolean(user.cookie_115),
      membershipType: user.membership_type || '',
      membershipExpiresAt: user.membership_expires_at || ''
    }
  });
});

// 1.4 会员状态查询（供前端判断是否过期）
router.get('/user/membership', (req, res) => {
  const username = req.query.username || '';
  if (!username) return res.status(400).json({ success: false, error: '缺少用户名' });
  const user = dbService.findUserByUsername(username);
  if (!user) return res.status(404).json({ success: false, error: '用户不存在' });
  const membership = dbService.checkUserMembership(user.id);
  res.json({ success: true, ...membership });
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
  const cleanUsername = username != null ? String(username).trim() : '';
  if (!cleanUsername) {
    return res.status(400).json({ success: false, error: '用户名不能为空' });
  }
  const user = dbService.findUserByUsername(cleanUsername);
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
  const cleanUsername = req.query && req.query.username != null ? String(req.query.username).trim() : 'default_user';
  const cid = req.query.cid || '0';
  const user = dbService.findUserByUsername(cleanUsername);

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
  const cleanUsername = username != null ? String(username).trim() : 'default_user';
  const user = dbService.findUserByUsername(cleanUsername);
  if (!user || !user.cookie_115) {
    return res.status(400).json({ success: false, error: '用户尚未绑定 115 网盘' });
  }

  const result = await openApi115.createDirectory(user.cookie_115, pid || '0', name.trim());
  res.json(result);
});

module.exports = router;
