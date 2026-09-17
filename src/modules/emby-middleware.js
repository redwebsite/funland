const express = require('express');
const axios = require('axios');
const { createProxyMiddleware } = require('http-proxy-middleware');
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
    const token = clientToken || apiKey();
    const headers = {};
    if (token) {
      headers['X-Emby-Token'] = token;
    }

    try {
      // 尝试查询 Items 详情
      const res = await axios.get(`${base}/emby/Items?Ids=${itemId}&Fields=Path,MediaSources,MediaStreams,Overview`, {
        headers,
        timeout: 4000
      });

      if (res.data && res.data.Items && res.data.Items.length > 0) {
        const item = res.data.Items[0];
        const mediaSource = item.MediaSources && item.MediaSources.length > 0 ? item.MediaSources[0] : null;
        const filePath = mediaSource ? mediaSource.Path : (item.Path || '');
        const filename = filePath ? filePath.split(/[\/\\]/).pop() : (item.Name || `Item-${itemId}`);

        return {
          id: itemId,
          name: item.Name || filename,
          filename,
          filePath,
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

  /**
   * 核心拦截器：处理视频流请求并实行 302 Found 重定向
   */
  async function handleStreamInterception(req, res, next) {
    const itemId = req.params.id;
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const clientToken = req.query.api_key || req.headers['x-emby-token'] || req.query['X-Emby-Token'] || '';
    const userId = req.query.UserId || req.query.userId || req.headers['x-emby-user-id'] || 'anonymous';

    console.log(`🎬 [Emby Proxy 8097] 拦截到播放流请求: ItemId=${itemId}, User=${userId}, IP=${clientIp}`);

    // 1. 检查 30 分钟滑动过期缓存 (Sliding Expiration Cache)
    const cacheKey = cacheScheduler.makeKey('stream:direct', itemId, userId);
    const cachedDirectUrl = cacheScheduler.get(cacheKey, true); // true = 命中时自动顺延 30 分钟

    if (cachedDirectUrl) {
      console.log(`⚡ [Cache Hit] 30分钟缓存命中: ItemId=${itemId}, 剩余TTL滑动刷新`);
      dbService.logPlayback(itemId, 'Cached-Media', userId, clientIp, 'CACHE_HIT', cachedDirectUrl);
      return res.redirect(302, cachedDirectUrl);
    }

    // 2. 检查本地 SQLite 是否已有该文件的 SHA1 索引
    let fileInfo = dbService.findFileByEmbyItemId(itemId);
    let mediaMetadata = null;

    if (!fileInfo) {
      // 从 Emby 上游抓取文件名和路径
      mediaMetadata = await fetchEmbyItemMetadata(itemId, clientToken);
      if (mediaMetadata.filename) {
        // 在 SQLite 中尝试按文件名匹配
        const allFiles = dbService.getAllIndexedFiles(500);
        fileInfo = allFiles.find(f => f.filename === mediaMetadata.filename);
      }
    }

    // 3. 执行 NextEmby Pro 架构：三级智能加速逻辑
    let resolvedDirectUrl = null;
    let accelerationModeUsed = 'NONE';

    // 获取当前请求用户
    const currentUser = dbService.findUserByUsername(userId) || (userId !== 'anonymous' ? dbService.findUserById(userId) : null);
    const userCookie = currentUser && currentUser.cookie_status === 'active' ? currentUser.cookie_115 : null;

    // --- STEP 1: 用户自有网盘匹配 (50ms) ---
    if (userCookie) {
      if (fileInfo && fileInfo.pickcode) {
        const linkRes = await openApi115.getDirectLink(userCookie, fileInfo.pickcode, fileInfo.file_id);
        if (linkRes.success) {
          resolvedDirectUrl = linkRes.downloadUrl;
          accelerationModeUsed = 'STEP1_OWN';
          console.log(`✅ [Step 1 命中] 用户自有网盘直链解析成功`);
        }
      } else if (mediaMetadata && mediaMetadata.filename) {
        // 在用户网盘中搜索文件名
        const searchRes = await openApi115.searchUserDrive(userCookie, mediaMetadata.filename);
        if (searchRes.found) {
          const linkRes = await openApi115.getDirectLink(userCookie, searchRes.pickcode, searchRes.fileId);
          if (linkRes.success) {
            resolvedDirectUrl = linkRes.downloadUrl;
            accelerationModeUsed = 'STEP1_OWN';
            // 写入本地文件索引
            dbService.recordFileIndex(
              searchRes.sha1 || `SHA1_${Date.now()}`,
              searchRes.filename,
              searchRes.filesize || 0,
              searchRes.pickcode,
              searchRes.fileId,
              itemId
            );
          }
        }
      }
    }

    // --- STEP 2: 用户间智能秒传加速 (5ms) ---
    if (!resolvedDirectUrl && fileInfo && fileInfo.sha1 && userCookie) {
      const peerUser = dbService.findRecentPeerWithFile(fileInfo.sha1, currentUser ? currentUser.id : 0);
      if (peerUser && peerUser.cookie_115) {
        console.log(`🤝 [Step 2 用户互传] 发现节点用户 ${peerUser.username} 拥有相同 SHA1，秒传至当前用户网盘`);
        const transferRes = await openApi115.fastTransfer(
          userCookie,
          fileInfo.sha1,
          fileInfo.filesize,
          fileInfo.filename
        );
        if (transferRes.success && transferRes.pickcode) {
          const linkRes = await openApi115.getDirectLink(userCookie, transferRes.pickcode, transferRes.fileId);
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

        if (fileInfo && fileInfo.pickcode) {
          const linkRes = await openApi115.getDirectLink(sourceCookieObj.cookie, fileInfo.pickcode, fileInfo.file_id);
          if (linkRes.success) {
            resolvedDirectUrl = linkRes.downloadUrl;
            accelerationModeUsed = 'STEP3_SOURCE';
          }
        } else if (mediaMetadata && mediaMetadata.filename) {
          const searchRes = await openApi115.searchUserDrive(sourceCookieObj.cookie, mediaMetadata.filename);
          if (searchRes.found) {
            const linkRes = await openApi115.getDirectLink(sourceCookieObj.cookie, searchRes.pickcode, searchRes.fileId);
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
            }
          }
        }
      }
    }

    // 4. 判断结果：如果解析到了直链，进行 302 Found 重定向并缓存 30 分钟
    if (resolvedDirectUrl) {
      console.log(`🚀 [302 Found] 成功获取直链，重定向客户端至 CDN: ${resolvedDirectUrl.substring(0, 60)}...`);
      // 存入滑动过期缓存 (默认 1800 秒 / 30 分钟)
      cacheScheduler.set(cacheKey, resolvedDirectUrl, config.cache.ttlSeconds);
      // 记录播放历史与热度
      if (fileInfo) dbService.updateFilePlayback(fileInfo.sha1);
      dbService.logPlayback(itemId, mediaMetadata ? mediaMetadata.name : 'Media Stream', userId, clientIp, accelerationModeUsed, resolvedDirectUrl);

      // 返回标准 HTTP 302 Found 重定向
      return res.redirect(302, resolvedDirectUrl);
    }

    // 5. 兜底回退：如果未配置网盘或直链解析未命中，无缝透明代理上游 Emby 原始流，确保播放绝不报错！
    console.log(`⚠️ [Fallback] 115 链路未命中，透明回退至真实 Emby 服务器串流`);
    dbService.logPlayback(itemId, mediaMetadata ? mediaMetadata.name : 'Media Stream', userId, clientIp, 'FALLBACK_EMBY', 'UPSTREAM_PROXY');
    return next();
  }

  // 挂载拦截路由规则 (完全兼容 Emby 规范)
  router.get('/Videos/:id/stream', handleStreamInterception);
  router.get('/Videos/:id/original', handleStreamInterception);
  router.get('/Videos/:id/stream.:ext', handleStreamInterception);
  router.get('/Videos/:id/master.m3u8', handleStreamInterception);
  router.get('/Items/:id/Download', handleStreamInterception);

  // 透明代理所有其他 Emby 请求（元数据、列表、海报、登录认证、系统接口）
  const proxyHandler = createProxyMiddleware({
    router: () => upstreamUrl(),
    changeOrigin: true,
    ws: true,
    xfwd: true,
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
