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

    // 提取源文件的关键元数据
    let sourcePickcode = (fileInfo && fileInfo.pickcode) || (mediaMetadata && mediaMetadata.pickcode) || '';
    if (!sourcePickcode && mediaMetadata && mediaMetadata.filePath) {
      const match = mediaMetadata.filePath.match(/pickcode=([a-z0-9]+)/i);
      if (match) sourcePickcode = match[1];
    }
    let sourceSha1 = fileInfo ? fileInfo.sha1 : '';
    let sourceFileId = fileInfo ? fileInfo.file_id : '';
    let sourceFilename = (fileInfo && fileInfo.filename) || (mediaMetadata ? mediaMetadata.filename : '');
    let sourceSize = (fileInfo && fileInfo.filesize) || (mediaMetadata ? mediaMetadata.size : 0);

    // 若本地索引尚未收录该文件的完整 SHA1 或 fileId，利用源盘直链接口快速探测指纹 (仅供沉淀索引与跨号秒传使用，绝不发送给小号客户端播放)
    if ((!sourceSha1 || !sourceFileId) && sourcePickcode) {
      try {
        const probe = await openApi115.getSourceDirectLink(sourcePickcode, clientUa);
        if (probe && probe.success) {
          if (probe.sha1 && !sourceSha1) sourceSha1 = probe.sha1;
          if (probe.fileId && !sourceFileId) sourceFileId = probe.fileId;
          if (probe.filename && !sourceFilename) sourceFilename = probe.filename;
          dbService.recordFileIndex(sourceSha1 || `SHA1_${sourcePickcode}`, sourceFilename, sourceSize, sourcePickcode, sourceFileId, itemId);
        }
      } catch (e) {}
    }

    let resolvedDirectUrl = null;
    let accelerationModeUsed = 'NONE';
    let resolvedUid = '';

    // ==========================================
    // 核心加速路由 A：用户已绑定 115 小号 (100% 由小号自行消化流量，大号彻底风险隔离)
    // ==========================================
    if (userCookie) {
      console.log(`🔍 [Step 1 检查小号盘] 用户 ${currentUserName} 已绑定 115，检查小号盘内是否已存在该视频...`);

      // 1. 先查本地 user_files 索引库 (该用户是否先前转存过该视频)
      if (sourceSha1 && currentUser) {
        const userSaved = dbService.getUserFile(currentUser.id, sourceSha1);
        if (userSaved && userSaved.pickcode) {
          const linkRes = await openApi115.getUserDirectLink(userCookie, userSaved.pickcode, userSaved.file_id, clientUa);
          if (linkRes.success) {
            resolvedDirectUrl = linkRes.downloadUrl;
            resolvedUid = linkRes.uid;
            accelerationModeUsed = 'STEP1_OWN_INDEX';
            console.log(`✅ [Step 1 命中] 从小号本地历史索引直出: Pickcode=${userSaved.pickcode}, UID=${resolvedUid || '小号'}`);
          }
        }
      }

      // 2. 尝试用 sourcePickcode 直接以小号 Cookie 解析 (若小号恰好拥有同源文件)
      if (!resolvedDirectUrl && sourcePickcode) {
        const linkRes = await openApi115.getUserDirectLink(userCookie, sourcePickcode, sourceFileId, clientUa);
        if (linkRes.success) {
          resolvedDirectUrl = linkRes.downloadUrl;
          resolvedUid = linkRes.uid;
          accelerationModeUsed = 'STEP1_OWN_PICKCODE';
          console.log(`✅ [Step 1 命中] 小号直接持有该 Pickcode 资源，小号直链签发成功 (UID: ${resolvedUid})`);
          if (sourceSha1 && currentUser) dbService.recordUserFile(currentUser.id, sourceSha1, sourcePickcode, sourceFileId);
        }
      }

      // 3. 在小号网盘全局搜索同名媒体文件
      if (!resolvedDirectUrl && sourceFilename) {
        const searchRes = await openApi115.searchUserDrive(userCookie, sourceFilename);
        if (searchRes.found && searchRes.pickcode) {
          console.log(`🎯 [Step 1 搜索命中] 在小号网盘匹配到已存文件: "${searchRes.filename}" (Pickcode: ${searchRes.pickcode})`);
          const linkRes = await openApi115.getUserDirectLink(userCookie, searchRes.pickcode, searchRes.fileId, clientUa);
          if (linkRes.success) {
            resolvedDirectUrl = linkRes.downloadUrl;
            resolvedUid = linkRes.uid;
            accelerationModeUsed = 'STEP1_OWN_SEARCH';
            console.log(`✅ [Step 1 命中] 由用户 ${currentUserName} 自有 Cookie 签发直链播放 (UID: ${resolvedUid})`);
            if (sourceSha1 && currentUser) dbService.recordUserFile(currentUser.id, sourceSha1, searchRes.pickcode, searchRes.fileId);
          }
        }
      }

      // 4. 小号网盘未持有该资源 -> 触发【秒传转存至小号的秒存目录】
      if (!resolvedDirectUrl) {
        console.log(`📦 [Step 2 秒传转存] 小号未持有 "${sourceFilename || itemId}"，开始秒传转存至小号秒存目录...`);

        // 确保小号秒存目录有效存在 (若用户未配置 save_cid_115 则自动探测/创建 /EmbyCache)
        let targetCid = currentUser ? currentUser.save_cid_115 : '';
        if (!targetCid || targetCid === '0') {
          const dirEnsure = await openApi115.ensureCacheDirectory(userCookie, (currentUser && currentUser.save_dir_115) || '/EmbyCache');
          if (dirEnsure.success && dirEnsure.cid) {
            targetCid = dirEnsure.cid;
            if (currentUser) dbService.updateUserSaveDir(currentUser.id, currentUser.save_dir_115 || '/EmbyCache', targetCid);
          }
        }

        // 4.1 优先分布式秒传 (P2P 用户间转存，完全不碰大号源盘)
        if (sourceSha1 && currentUser) {
          const peerUser = dbService.findRecentPeerWithFile(sourceSha1, currentUser.id);
          if (peerUser && peerUser.cookie_115 && (peerUser.file_id || sourceFileId)) {
            console.log(`🤝 [Step 2 P2P互传] 发现节点用户 ${peerUser.username} 拥有相同资源，秒传至用户 ${currentUserName}`);
            const p2pRes = await openApi115.shareAndReceiveFile(
              peerUser.cookie_115,
              userCookie,
              peerUser.file_id || sourceFileId,
              targetCid,
              sourceFilename
            );
            if (p2pRes.success && p2pRes.pickcode) {
              const linkRes = await openApi115.getUserDirectLink(userCookie, p2pRes.pickcode, p2pRes.fileId, clientUa);
              if (linkRes.success) {
                resolvedDirectUrl = linkRes.downloadUrl;
                resolvedUid = linkRes.uid;
                accelerationModeUsed = 'STEP2_PEER_P2P';
                console.log(`🎉 [Step 2 P2P成功] 用户间互传完成！直链由小号 Cookie 签发 (UID: ${resolvedUid})`);
                dbService.recordUserFile(currentUser.id, sourceSha1, p2pRes.pickcode, p2pRes.fileId);
              }
            }
          }
        }

        // 4.2 若 P2P 未命中，通过源网盘 Cookie 池秒传转存至小号
        if (!resolvedDirectUrl && sourceFileId) {
          const sourceCookieObj = dbService.getActiveSourceCookie();
          if (sourceCookieObj && sourceCookieObj.cookie) {
            console.log(`🚀 [Step 3 源盘转存] 唤醒源网盘 (${sourceCookieObj.name || 'Master'}) 秒传转存至小号目录 (${targetCid})...`);
            dbService.updateCookieUsed(sourceCookieObj.id);

            const transferRes = await openApi115.shareAndReceiveFile(
              sourceCookieObj.cookie,
              userCookie,
              sourceFileId,
              targetCid,
              sourceFilename
            );

            if (transferRes.success && transferRes.pickcode) {
              const linkRes = await openApi115.getUserDirectLink(userCookie, transferRes.pickcode, transferRes.fileId, clientUa);
              if (linkRes.success) {
                resolvedDirectUrl = linkRes.downloadUrl;
                resolvedUid = linkRes.uid;
                accelerationModeUsed = 'STEP3_SOURCE_TRANSFERRED';
                console.log(`🎉 [Step 3 转存成功] 文件已落库小号秒存目录！直链由小号 Cookie 签发 (UID: ${resolvedUid})，大号风险0`);
                if (sourceSha1 && currentUser) {
                  dbService.recordUserFile(currentUser.id, sourceSha1, transferRes.pickcode, transferRes.fileId);
                  dbService.recordFileUser(sourceSha1, currentUser.id);
                }
              }
            } else {
              console.warn(`⚠️ [Step 3] 源网盘秒传转存失败: ${transferRes.error}`);
            }
          } else {
            console.warn(`ℹ️ [Step 3] 源网盘 Cookie 资源池暂无活跃账号，无法执行跨号秒传转存`);
          }
        }
      }

      // 5. 严格隔离校验：若未能从小号生成专属直链
      if (!resolvedDirectUrl) {
        const allowMasterFallback = dbService.getSetting('allow_master_direct_fallback', 'false') === 'true';
        if (allowMasterFallback && sourcePickcode) {
          console.warn(`⚠️ [大号兜底警告] 小号转存未就绪，但管理员设置允许大号直链兜底，正在签发源盘大号直链...`);
          const masterLink = await openApi115.getSourceDirectLink(sourcePickcode, clientUa);
          if (masterLink.success) {
            resolvedDirectUrl = masterLink.downloadUrl;
            resolvedUid = masterLink.uid;
            accelerationModeUsed = 'MASTER_FALLBACK_RISK';
          }
        } else {
          console.log(`🛡️ [大号风险隔离] 小号未持有该文件且无法转存，已彻底阻断大号 CDN 泄露！透明回退至真实 Emby 串流`);
          dbService.logPlayback(itemId, sourceFilename || 'Media Stream', currentUserName, clientIp, 'FALLBACK_EMBY_ISOLATED', 'UPSTREAM_PROXY');
          return next();
        }
      }
    } else {
      // ==========================================
      // 核心加速路由 B：未绑定 115 的用户 (游客 / 本地回源模式)
      // ==========================================
      const allowMasterForGuests = dbService.getSetting('allow_master_for_guests', 'false') === 'true';
      if (allowMasterForGuests && sourcePickcode) {
        const masterLink = await openApi115.getSourceDirectLink(sourcePickcode, clientUa);
        if (masterLink.success) {
          resolvedDirectUrl = masterLink.downloadUrl;
          resolvedUid = masterLink.uid;
          accelerationModeUsed = 'MASTER_GUEST_DIRECT';
        }
      }
      if (!resolvedDirectUrl) {
        console.log(`ℹ️ [游客模式] 用户 ${currentUserName} 尚未绑定 115，透明回退至真实 Emby 服务器本地串流`);
        dbService.logPlayback(itemId, sourceFilename || 'Media Stream', currentUserName, clientIp, 'FALLBACK_EMBY_GUEST', 'UPSTREAM_PROXY');
        return next();
      }
    }

    // 4. 判断结果：如果解析到了直链，进行 302 Found 重定向并缓存 30 分钟
    if (resolvedDirectUrl) {
      console.log(`🚀 [302 Found] 成功获取直链 (模式: ${accelerationModeUsed}, UID: ${resolvedUid || '小号'})，重定向客户端至 CDN: ${resolvedDirectUrl.substring(0, 60)}...`);
      // 存入滑动过期缓存 (默认 1800 秒 / 30 分钟)
      cacheScheduler.set(cacheKey, resolvedDirectUrl, config.cache.ttlSeconds);

      // 记录播放历史与热度
      if (sourceSha1) dbService.updateFilePlayback(sourceSha1);
      dbService.logPlayback(itemId, sourceFilename || 'Media Stream', currentUserName, clientIp, accelerationModeUsed, resolvedDirectUrl);

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
    dbService.logPlayback(itemId, sourceFilename || 'Media Stream', currentUserName, clientIp, 'FALLBACK_EMBY', 'UPSTREAM_PROXY');
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
