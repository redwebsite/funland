const express = require('express');
const { dbService } = require('../db/database');
const openApi115 = require('../modules/openapi-115');
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
router.post('/user/register', (req, res) => {
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

  const existing = dbService.findUserByUsername(username.trim());
  if (existing) {
    return res.status(400).json({ success: false, error: '该用户名已被占用' });
  }

  const crypto = require('crypto');
  const passwordHash = crypto.createHash('sha256').update(password.trim()).digest('hex');
  const newId = dbService.createUser(username.trim(), passwordHash);

  res.json({
    success: true,
    msg: '注册成功！请登录并绑定您的 115 账号',
    data: {
      id: newId,
      username: username.trim(),
      cookieStatus: 'unbound'
    }
  });
});

// 1.3 用户登录接口
router.post('/user/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '请输入用户名和密码' });
  }

  const user = dbService.findUserByUsername(username.trim());
  if (!user) {
    return res.status(401).json({ success: false, error: '用户名或密码错误' });
  }

  if (user.cookie_status === 'disabled') {
    return res.status(403).json({ success: false, error: '该用户已被管理员停用' });
  }

  const crypto = require('crypto');
  const passwordHash = crypto.createHash('sha256').update(password.trim()).digest('hex');
  if (user.password_hash && user.password_hash !== passwordHash) {
    return res.status(401).json({ success: false, error: '用户名或密码错误' });
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
    dbService.updateUser115Cookie(user.id, result.cookie, 'active');
    result.boundUser = targetUsername;
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

  dbService.updateUser115Cookie(user.id, cookie, 'active');

  res.json({
    success: true,
    msg: `成功绑定 115 账号: ${check.username}！`,
    data: check
  });
});

// 5. 校验用户网盘绑定状态
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
  res.json({
    success: true,
    bound: check.valid,
    cookieStatus: user.cookie_status,
    data: check
  });
});

module.exports = router;
