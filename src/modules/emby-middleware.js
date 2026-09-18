const express = require('express');
const axios = require('axios');
const https = require('https');
const { createProxyMiddleware } = require('http-proxy-middleware');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const config = require('../config');
const { dbService } = require('../db/database');
const cacheScheduler = require('./cache-scheduler');
const openApi115 = require('./openapi-115');

/**
 * Funland Emby 播放请求反代与 302 重定向中间件 (8097 端口)
 */
function createEmbyMiddleware() {
  const router = express.Router();
  const upstreamUrl = () => dbService.getSetting('emby_upstream_url', config.emby.upstreamUrl);
  const apiKey = () => dbService.getSetting('emby_api_key', config.emby.apiKey);

  /**
   * 从 Emby 上游 API 查询媒体信息
   */
  async function fetchEmbyItemMetadata(itemId, clientToken = '') {
    const base = upstreamUrl().replace(/\/+$/, '');
    const token = apiKey() || clientToken;
    const headers = {};
    if (token) {
      headers['X-Emby-Token'] = token;
    }

    try {
      // 优先使用管理员 API Key 查询 Items 完整详情（确保 Path 与 MediaSources 不被普通用户权限过滤）
      const res = await axios.get(`${base}/emby/Items?Ids=${itemId}&Fields=Path,MediaSources,MediaStreams,Overview,SeriesName,SeasonName`, {
        headers,
        timeout: 4000,
        httpsAgent
      });

      if (res.data && res.data.Items && res.data.Items.length > 0) {
        const item = res.data.Items[0];
        const mediaSource = item.MediaSources && item.MediaSources.length > 0 ? item.MediaSources[0] : null;
        const filePath = mediaSource ? (mediaSource.Path || '') : (item.Path || '');
        let filename = filePath ? filePath.split(/[\/\\]/).pop() : (item.Name || `Item-${itemId}`);

        // 从路径或 URL 中提取 pickcode (适用于 strm 虚拟文件、直链或 115 结构)
        let pickcode = '';
        const pickcodeMatch = filePath.match(/[?&]pickcode=([a-z0-9]+)/i) || filePath.match(/115:\/\/([a-z0-9]+)/i);
        if (pickcodeMatch) {
          pickcode = pickcodeMatch[1];
        }

        // 若为 .strm 文件，清洗掉后缀以匹配 115 网盘上的真实视频名
        filename = filename.replace(/\.strm$/i, '');

        // 如果是剧集且未获取到独立文件名，组合剧集名与单集名进行精准搜索
        if (item.SeriesName && (!filePath || filename === item.Name)) {
          filename = `${item.SeriesName} ${item.Name}`;
        }

        console.log(`📋 [Emby Metadata] ItemId=${itemId}, Name="${item.Name}", Path="${filePath}", File="${filename}", Pickcode="${pickcode || 'none'}"`);

        return {
          id: itemId,
          name: item.Name || filename,
          filename,
          filePath,
          pickcode,
          size: mediaSource ? mediaSource.Size : 0
        };
      }
    } catch (e) {
      console.warn(`[Emby Proxy] 查询上游媒体项 ${itemId} 失败:`, e.message);
    }

    return {
      id: itemId,
      name: `Media-${itemId}`,
      filename: `Media-${itemId}`,
      filePath: '',
      size: 0
    };
  }

  // 智能捕获客户端 Emby 用户 Token 与 UserId 的映射
  const tokenToUserMap = new Map();

  /**
   * 核心拦截器：处理视频流请求并实行 302 Found 重定向
   */
  async function handleStreamInterception(req, res, next) {
    const itemId = req.params.id;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const clientUa = req.headers['user-agent'] || '';
    const clientToken = req.query.api_key || req.headers['x-emby-token'] || req.query['X-Emby-Token'] || '';
    let userId = req.query.UserId || req.query.userId || req.headers['x-emby-user-id'] || '';

    // 若流请求未带 UserId 参数，则通过 Token 映射还原 Emby 真实用户
    if (!userId && clientToken && tokenToUserMap.has(clientToken)) {
      userId = tokenToUserMap.get(clientToken);
    }
    if (!userId) userId = 'anonymous';

    // 获取当前请求用户
    const currentUser = dbService.findUserByUsername(userId) ||
                        dbService.findUserByEmbyUserId(userId) ||
                        (userId !== 'anonymous' && /^\d+$/.test(userId) ? dbService.findUserById(userId) : null);
    const userCookie = currentUser && currentUser.cookie_status === 'active' ? currentUser.cookie_115 : null;
    const currentUserName = currentUser ? currentUser.username : (userId || 'anonymous');

    console.log(`🎬 [Emby Proxy 8097] 拦截到播放流请求: ItemId=${itemId}, 用户=${currentUserName} (${userId}), UA="${clientUa.substring(0, 50)}", IP=${clientIp}`);

    // 1. 检查 30 分钟滑动过期缓存 (结合 UA 指纹，杜绝签名不匹配导致 115 CDN 403)
    const cacheKey = cacheScheduler.makeKey('stream:direct', itemId, currentUserName, clientUa);
    const cachedDirectUrl = cacheScheduler.get(cacheKey, true); // true = 命中时自动顺延 30 分钟

    if (cachedDirectUrl) {
      console.log(`⚡ [Cache Hit] 30分钟缓存命中: ItemId=${itemId}, 剩余TTL滑动刷新`);
      dbService.logPlayback(itemId, 'Cached-Media', currentUserName, clientIp, 'CACHE_HIT', cachedDirectUrl);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Location, Range, Content-Length, Content-Range');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.redirect(302, cachedDirectUrl);
    }

    // 2. 检查本地 SQLite 是否已有该文件的 SHA1 / Pickcode 索引
    let fileInfo = dbService.findFileByEmbyItemId(itemId);
    let mediaMetadata = null;

    if (!fileInfo || !fileInfo.pickcode) {
      // 从 Emby 上游抓取文件名和路径
      mediaMetadata = await fetchEmbyItemMetadata(itemId, clientToken);
      if (mediaMetadata && mediaMetadata.filename) {
        // 在 SQLite 中尝试按文件名匹配
        const allFiles = dbService.getAllIndexedFiles(500);
        const matchByName = allFiles.find(f => f.filename === mediaMetadata.filename);
        if (matchByName) fileInfo = matchByName;
      }
    }

    const targetPickcode = (fileInfo && fileInfo.pickcode) || (mediaMetadata && mediaMetadata.pickcode) || '';

    // 3. 执行三级智能加速逻辑
    let resolvedDirectUrl = null;
    let accelerationModeUsed = 'NONE';

    // 优先：若 Emby 媒体路径本身为 P115StrmHelper / HTTP 302 节点直链，直接按客户端真实 UA 高速解析出 115 官方 CDN 真实直链
    if (mediaMetadata && mediaMetadata.filePath && (mediaMetadata.filePath.startsWith('http://') || mediaMetadata.filePath.startsWith('https://'))) {
      try {
        const helperHeaders = {};
        if (clientUa) helperHeaders['User-Agent'] = clientUa;
        const res = await axios.get(mediaMetadata.filePath, {
          headers: helperHeaders,
          maxRedirects: 0,
          validateStatus: s => s >= 200 && s < 400,
          timeout: 5000,
          httpsAgent
        });
        if (res.status >= 300 && res.status < 400 && res.headers.location) {
          resolvedDirectUrl = res.headers.location;
          accelerationModeUsed = userCookie ? 'STEP1_OWN' : 'STEP3_SOURCE';
          console.log(`✅ [${accelerationModeUsed === 'STEP1_OWN' ? 'Step 1' : 'Step 3'} 命中] 直链节点解析成功，获得 115 官方 CDN 链接: ${resolvedDirectUrl.substring(0, 60)}...`);
        }
      } catch (e) {
        if (e.response && e.response.headers && e.response.headers.location) {
          resolvedDirectUrl = e.response.headers.location;
          accelerationModeUsed = userCookie ? 'STEP1_OWN' : 'STEP3_SOURCE';
          console.log(`✅ [${accelerationModeUsed === 'STEP1_OWN' ? 'Step 1' : 'Step 3'} 命中] 直链节点解析成功，获得 115 官方 CDN 链接: ${resolvedDirectUrl.substring(0, 60)}...`);
        }
      }
    }

    // --- STEP 1: 用户自有网盘匹配 (50ms) ---
    if (!resolvedDirectUrl && userCookie) {
      console.log(`🔍 [Step 1 用户盘] 检索用户 ${currentUserName} 的 115 资源: ${targetPickcode ? `Pickcode=${targetPickcode}` : `名称="${mediaMetadata ? mediaMetadata.filename : itemId}"`}`);
      if (targetPickcode) {
        const linkRes = await openApi115.getDirectLink(userCookie, targetPickcode, fileInfo ? fileInfo.file_id : '', clientUa);
        if (linkRes.success) {
          resolvedDirectUrl = linkRes.downloadUrl;
          accelerationModeUsed = 'STEP1_OWN';
          console.log(`✅ [Step 1 命中] 用户 ${currentUserName} 自有网盘直链解析成功 (Pickcode: ${targetPickcode})`);
        } else {
          console.warn(`⚠️ [Step 1] 用户网盘解析 Pickcode (${targetPickcode}) 直链未成功: ${linkRes.error}`);
        }
      } else if (mediaMetadata && (mediaMetadata.filename || mediaMetadata.name)) {
        const searchTarget = mediaMetadata.filename || mediaMetadata.name;
        const searchRes = await openApi115.searchUserDrive(userCookie, searchTarget);
        if (searchRes.found && searchRes.pickcode) {
          console.log(`🎯 [Step 1 搜索命中] 在用户网盘匹配到文件: "${searchRes.filename}" (Pickcode: ${searchRes.pickcode})`);
          const linkRes = await openApi115.getDirectLink(userCookie, searchRes.pickcode, searchRes.fileId, clientUa);
          if (linkRes.success) {
            resolvedDirectUrl = linkRes.downloadUrl;
            accelerationModeUsed = 'STEP1_OWN';
            dbService.recordFileIndex(
              searchRes.sha1 || `SHA1_${Date.now()}`,
              searchRes.filename,
              searchRes.filesize || 0,
              searchRes.pickcode,
              searchRes.fileId,
              itemId
            );
            console.log(`✅ [Step 1 命中] 用户 ${currentUserName} 自有网盘直链获取成功: ${searchRes.filename}`);
          } else {
            console.warn(`⚠️ [Step 1] 获取直链失败: ${linkRes.error}`);
          }
        } else {
          console.log(`ℹ️ [Step 1 未命中] 用户网盘未检索到匹配文件: "${searchTarget}"`);
        }
      }
    } else if (!userCookie && !resolvedDirectUrl) {
      console.log(`ℹ️ [Step 1 跳过] 用户 ${currentUserName} 尚未绑定有效 115 Cookie`);
    }

    // --- STEP 2: 用户间智能秒传加速 (5ms) ---
    if (!resolvedDirectUrl && fileInfo && fileInfo.sha1 && userCookie) {
      const peerUser = dbService.findRecentPeerWithFile(fileInfo.sha1, currentUser ? currentUser.id : 0);
      if (peerUser && peerUser.cookie_115) {
        console.log(`🤝 [Step 2 用户互传] 发现节点用户 ${peerUser.username} 拥有相同 SHA1，秒传至当前用户网盘`);
        const targetCid = currentUser && currentUser.save_cid_115 ? currentUser.save_cid_115 : 0;
        const transferRes = await openApi115.fastTransfer(
          userCookie,
          fileInfo.sha1,
          fileInfo.filesize,
          fileInfo.filename,
          targetCid
        );
        if (transferRes.success && transferRes.pickcode) {
          const linkRes = await openApi115.getDirectLink(userCookie, transferRes.pickcode, transferRes.fileId, clientUa);
          if (linkRes.success) {
            resolvedDirectUrl = linkRes.downloadUrl;
            accelerationModeUsed = 'STEP2_PEER';
            // 记录当前用户也拥有该文件
            if (currentUser) dbService.recordFileUser(fileInfo.sha1, currentUser.id);
          }
        }
      }
    }

    // --- STEP 3: 源网盘 / Cookie 池兜底保障 ---
    if (!resolvedDirectUrl) {
      const sourceCookieObj = dbService.getActiveSourceCookie();
      if (sourceCookieObj) {
        console.log(`📦 [Step 3 源盘兜底] 从公共/源网盘资源池提取直链或执行秒传`);
        dbService.updateCookieUsed(sourceCookieObj.id);

        if (targetPickcode) {
          const linkRes = await openApi115.getDirectLink(sourceCookieObj.cookie, targetPickcode, fileInfo ? fileInfo.file_id : '', clientUa);
          if (linkRes.success) {
            resolvedDirectUrl = linkRes.downloadUrl;
            accelerationModeUsed = 'STEP3_SOURCE';
            console.log(`✅ [Step 3 命中] 源网盘根据 Pickcode (${targetPickcode}) 直链解析成功`);
          }
        } else if (mediaMetadata && (mediaMetadata.filename || mediaMetadata.name)) {
          const searchTarget = mediaMetadata.filename || mediaMetadata.name;
          const searchRes = await openApi115.searchUserDrive(sourceCookieObj.cookie, searchTarget);
          if (searchRes.found && searchRes.pickcode) {
            console.log(`🎯 [Step 3 搜索命中] 在源网盘匹配到文件: "${searchRes.filename}" (Pickcode: ${searchRes.pickcode})`);
            const linkRes = await openApi115.getDirectLink(sourceCookieObj.cookie, searchRes.pickcode, searchRes.fileId, clientUa);
            if (linkRes.success) {
              resolvedDirectUrl = linkRes.downloadUrl;
              accelerationModeUsed = 'STEP3_SOURCE';
              dbService.recordFileIndex(
                searchRes.sha1 || `SHA1_${Date.now()}`,
                searchRes.filename,
                searchRes.filesize || 0,
                searchRes.pickcode,
                searchRes.fileId,
                itemId
              );
              console.log(`✅ [Step 3 命中] 源网盘直链获取成功: ${searchRes.filename}`);
            }
          } else {
            console.log(`ℹ️ [Step 3 未命中] 源网盘未检索到匹配文件: "${searchTarget}"`);
          }
        }
      }
    }

    // 4. 判断结果：如果解析到了直链，进行 302 Found 重定向并缓存 30 分钟
    if (resolvedDirectUrl) {
      console.log(`🚀 [302 Found] 成功获取直链，重定向客户端至 CDN: ${resolvedDirectUrl.substring(0, 60)}...`);
      // 存入滑动过期缓存 (默认 1800 秒 / 30 分钟)
      cacheScheduler.set(cacheKey, resolvedDirectUrl, config.cache.ttlSeconds);

      // 从 115 官方 CDN 链接中提取 SHA1 与文件名进行指纹沉淀与秒传同步
      try {
        const sha1Match = resolvedDirectUrl.match(/115cdn\.net\/([a-f0-9]{40})\//i);
        const sha1 = sha1Match ? sha1Match[1] : '';
        const urlSegments = resolvedDirectUrl.split('?')[0].split('/');
        const encodedName = urlSegments[urlSegments.length - 1];
        const realFilename = encodedName ? decodeURIComponent(encodedName) : (mediaMetadata ? mediaMetadata.name : 'Media');
        const realSize = mediaMetadata ? (mediaMetadata.size || 0) : 0;

        if (sha1) {
          dbService.recordFileIndex(sha1, realFilename, realSize, targetPickcode, '', itemId);
          if (currentUser) dbService.recordFileUser(sha1, currentUser.id);

          // 若当前用户已绑定 115 且为 Step 1，自动在后台秒传留存至用户网盘
          if (userCookie && accelerationModeUsed === 'STEP1_OWN') {
            const targetCid = currentUser && currentUser.save_cid_115 ? currentUser.save_cid_115 : 0;
            openApi115.fastTransfer(userCookie, sha1, realSize, realFilename, targetCid).then(res => {
              if (res && res.success) {
                console.log(`💾 [自动秒传] 视频 "${realFilename}" 已自动转存至用户 ${currentUserName} 的 115 网盘 (Cid: ${targetCid})`);
              }
            }).catch(() => {});
          }
        }
      } catch (e) {}

      // 记录播放历史与热度
      if (fileInfo) dbService.updateFilePlayback(fileInfo.sha1);
      dbService.logPlayback(itemId, mediaMetadata ? mediaMetadata.name : 'Media Stream', currentUserName, clientIp, accelerationModeUsed, resolvedDirectUrl);

      // 返回标准 HTTP 302 Found 重定向，附带全套 CORS 头部与防缓存头部保障各端播放器顺畅跟随
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', 'Location, Range, Content-Length, Content-Range');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      return res.redirect(302, resolvedDirectUrl);
    }

    // 5. 兜底回退：如果未配置网盘或直链解析未命中，无缝透明代理上游 Emby 原始流，确保播放绝不报错！
    console.log(`⚠️ [Fallback] 115 链路未命中，透明回退至真实 Emby 服务器串流`);
    dbService.logPlayback(itemId, mediaMetadata ? mediaMetadata.name : 'Media Stream', currentUserName, clientIp, 'FALLBACK_EMBY', 'UPSTREAM_PROXY');
    return next();
  }

  // 智能捕获客户端 Emby 用户 Token 与 UserId 的映射
  router.use((req, res, next) => {
    const token = req.query.api_key || req.headers['x-emby-token'] || req.query['X-Emby-Token'];
    const embyUserId = req.query.UserId || req.query.userId || req.headers['x-emby-user-id'];
    const userPathMatch = req.path.match(/^(?:\/emby)?\/users\/([a-f0-9]{20,40})/i);
    const resolvedUserId = embyUserId || (userPathMatch ? userPathMatch[1] : null);

    if (token && resolvedUserId) {
      tokenToUserMap.set(token, resolvedUserId);
    }
    next();
  });

  // 跨域 OPTIONS 预检请求快速放行
  router.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Max-Age', '86400');
      return res.sendStatus(204);
    }
    next();
  });

  // 挂载核心拦截路由规则 (完美兼容 /emby/Videos/... 与 /Videos/... 各类客户端规范)
  const STREAM_PATH_REGEX = /^(?:\/emby)?\/(?:videos\/([^\/\?]+)\/(stream|original|master\.m3u8|main\.m3u8)(?:\.[a-zA-Z0-9]+)?|items\/([^\/\?]+)\/download)/i;

  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }
    const match = req.path.match(STREAM_PATH_REGEX);
    if (match) {
      req.params = req.params || {};
      req.params.id = match[1] || match[3];
      return handleStreamInterception(req, res, next);
    }
    next();
  });

  // 核心优化：针对 Sessions/Playing/Stopped 等会话报告接口实行 Fast-Ack 闪电响应 (204 No Content)
  // 背景：Forward、Rex、Infuse 等移动端/iPad 架构播放器在停止播放时会向服务端上报 Stopped，
  // 并在本地线程通过 SQLite (如 WCDB) 写入播放记录。若上游 Emby 处于海外或网络高延迟（800ms+），
  // 客户端等待响应期间若用户将窗口置于后台或切换应用，macOS RunningBoard 守护进程会因检测到后台挂起进程持有 SQLite 锁而强制 SIGKILL (0xdead10cc)。
  // Funland 在 <1ms 内秒回 204 解除客户端死等，让其瞬间释放本地事务与数据库锁；同时在后台异步静默透传给上游 Emby，确保服务端进度同步记录！
  const SESSION_FAST_ACK_REGEX = /^(?:\/emby)?\/sessions\/playing\/(stopped|progress|ping)$/i;

  router.post(SESSION_FAST_ACK_REGEX, express.raw({ type: '*/*' }), (req, res) => {
    // 1. 立即返回 204 No Content
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.status(204).end();

    // 2. 后台异步转发至真实上游 Emby 服务器
    const base = upstreamUrl().replace(/\/+$/, '');
    let reqPath = req.originalUrl || req.url;
    if (!reqPath.startsWith('/emby') && !base.endsWith('/emby')) {
      reqPath = '/emby' + (reqPath.startsWith('/') ? reqPath : '/' + reqPath);
    }
    const targetUrl = `${base}${reqPath}`;

    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    delete forwardHeaders['content-length'];

    axios({
      method: 'POST',
      url: targetUrl,
      data: req.body && req.body.length > 0 ? req.body : undefined,
      headers: forwardHeaders,
      timeout: 8000,
      httpsAgent
    }).catch(err => {
      console.warn(`[Emby Proxy] 后台异步同步 ${req.path} 失败: ${err.message}`);
    });
  });

  // 透明代理所有其他 Emby 请求（元数据、列表、海报、登录认证、系统接口）
  const proxyHandler = createProxyMiddleware({
    router: () => upstreamUrl(),
    changeOrigin: true,
    ws: true,
    xfwd: true,
    secure: false, // 允许自签名或 IP HTTPS 证书
    logger: console,
    on: {
      error: (err, req, res) => {
        console.error(`[Emby Proxy Error] 代理至上游异常 (${req.url}):`, err.message);
        if (!res.headersSent) {
          res.status(502).json({
            error: 'Funland Emby Proxy Error',
            message: '无法连接到上游 Emby 服务器，请在管理后台检查配置',
            upstream: upstreamUrl()
          });
        }
      }
    }
  });

  router.use(proxyHandler);

  return router;
}

module.exports = {
  createEmbyMiddleware
};
