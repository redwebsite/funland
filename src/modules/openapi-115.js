const axios = require('axios');
const qrcode = require('qrcode');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

class OpenApi115 {
  constructor() {
    this.http = axios.create({
      timeout: 10000,
      headers: {
        'User-Agent': USER_AGENT
      }
    });
  }

  /**
   * 1. 扫码登录：创建扫码会话并生成二维码 DataURL
   */
  async createQrSession() {
    try {
      const res = await this.http.get('https://qrcodeapi.115.com/api/1.0/web/1.0/token/');
      if (res.data && res.data.state === 1 && res.data.data) {
        const { uid, time, sign, qrcode: qrUrl } = res.data.data;
        const targetUrl = qrUrl || `https://qrcode.115.com/download/app/?uid=${uid}`;
        const qrDataUrl = await qrcode.toDataURL(targetUrl, {
          margin: 2,
          width: 280,
          color: {
            dark: '#1e293b',
            light: '#ffffff'
          }
        });

        return {
          success: true,
          uid,
          time,
          sign,
          qrDataUrl,
          qrUrl: targetUrl
        };
      }
      throw new Error(res.data ? res.data.msg || '获取115扫码Token失败' : '上游返回为空');
    } catch (e) {
      console.error('❌ [115] 创建扫码会话异常:', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * 2. 扫码登录：轮询扫码状态
   */
  async checkQrStatus(uid, time, sign) {
    try {
      const url = `https://qrcodeapi.115.com/get/status/?uid=${uid}&time=${time}&sign=${sign}&_=${Date.now()}`;
      const res = await this.http.get(url);
      const data = res.data ? res.data.data : null;

      if (!data) {
        return { status: 'unknown', msg: '未知响应' };
      }

      // status: 0=待扫, 1=已扫待确认, 2=已确认登录, -1=已失效
      const statusCode = data.status;
      if (statusCode === 0) {
        return { status: 'waiting', msg: '等待手机端 115 App 扫码' };
      } else if (statusCode === 1) {
        return { status: 'scanned', msg: '已扫码，请在手机端点击【确认登录】' };
      } else if (statusCode === 2) {
        // 确认登录完成，换取 Cookie
        const loginRes = await this.http.post(
          'https://passportapi.115.com/app/1.0/web/1.0/login/qrcode/',
          `account=${encodeURIComponent(uid)}`,
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            }
          }
        );

        let cookieString = '';
        const setCookie = loginRes.headers['set-cookie'];
        if (setCookie && Array.isArray(setCookie)) {
          cookieString = setCookie.map(c => c.split(';')[0]).join('; ');
        } else if (loginRes.data && loginRes.data.data && loginRes.data.data.cookie) {
          cookieString = Object.entries(loginRes.data.data.cookie).map(([k, v]) => `${k}=${v}`).join('; ');
        }

        return {
          status: 'confirmed',
          msg: '登录成功！',
          cookie: cookieString
        };
      } else if (statusCode === -1) {
        return { status: 'expired', msg: '二维码已失效，请重新刷新' };
      }

      return { status: 'pending', msg: data.msg || '处理中' };
    } catch (e) {
      return { status: 'error', error: e.message };
    }
  }

  /**
   * 3. Cookie 有效性及用户信息验证
   */
  async validateCookie(cookie) {
    if (!cookie || typeof cookie !== 'string' || !cookie.includes('UID=')) {
      return { valid: false, error: 'Cookie 格式无效（必须包含 UID 等凭据）' };
    }

    try {
      const res = await this.http.get('https://my.115.com/?ct=ajax&ac=nav', {
        headers: {
          Cookie: cookie
        }
      });

      if (res.data && res.data.state) {
        const data = res.data.data || {};
        return {
          valid: true,
          userId: data.user_id || '',
          username: data.user_name || '115用户',
          isVip: Boolean(data.vip && data.vip.status),
          vipExpire: data.vip && data.vip.expire_time ? data.vip.expire_time : '未知',
          spaceUsed: data.space ? data.space.used : '',
          spaceTotal: data.space ? data.space.total : ''
        };
      }
      return { valid: false, error: 'Cookie 已过期或已失效' };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }

  /**
   * 4. 专属小号直链解析：严格仅使用用户自有 Cookie 请求 115 官方接口，直链签名 100% 归属于小号 UID，彻底杜绝大号泄露
   */
  async getUserDirectLink(cookie, pickcode, fileId = '', clientUserAgent = '') {
    if (!cookie) return { success: false, error: '缺少用户 115 Cookie' };
    if (!pickcode) return { success: false, error: '缺少 pickcode' };

    try {
      const url = `https://proapi.115.com/app/chrome/downurl?pickcode=${pickcode}`;
      const res = await this.http.get(url, {
        headers: {
          Cookie: cookie,
          Referer: 'https://115.com/',
          'User-Agent': clientUserAgent || USER_AGENT
        },
        timeout: 5000
      });

      if (res.data && res.data.state && res.data.data) {
        const fileObj = fileId ? res.data.data[fileId] : Object.values(res.data.data)[0];
        if (fileObj && fileObj.url && fileObj.url.url) {
          const directUrl = fileObj.url.url;
          const uMatch = directUrl.match(/[?&]u=(\d+)/);
          const linkUid = uMatch ? uMatch[1] : '';

          return {
            success: true,
            downloadUrl: directUrl,
            fileId: fileId || Object.keys(res.data.data)[0],
            filename: fileObj.file_name || '',
            filesize: fileObj.file_size || 0,
            pickcode,
            uid: linkUid
          };
        }
      }
      return {
        success: false,
        error: res.data ? (res.data.msg || '无法从小号网盘解析到直链地址') : '115上游无响应'
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 5. 源网盘直链/元数据解析助手 (仅供提取 SHA1/真实文件名 等指纹，或管理员明确开启大号兜底时使用)
   */
  async getSourceDirectLink(pickcode, clientUserAgent = '') {
    if (!pickcode) return { success: false, error: '缺少 pickcode' };
    try {
      const helperUrl = `http://158.101.5.12:65041/api/v1/plugin/P115StrmHelper/redirect_url?pickcode=${pickcode}`;
      const reqHeaders = {};
      if (clientUserAgent) reqHeaders['User-Agent'] = clientUserAgent;
      const res = await this.http.get(helperUrl, {
        headers: reqHeaders,
        maxRedirects: 0,
        validateStatus: s => s >= 200 && s < 400,
        timeout: 5000
      });

      const location = (res.status >= 300 && res.status < 400 && res.headers.location) ? res.headers.location : null;
      if (location) {
        const sha1Match = location.match(/115cdn\.net\/([a-f0-9]{40})\//i);
        const uMatch = location.match(/[?&]u=(\d+)/);
        const cdHeader = (res.headers && res.headers['content-disposition']) || '';
        let realFilename = '';
        if (cdHeader) {
          const cdMatch = cdHeader.match(/filename\*=UTF-8''([^;]+)/i) || cdHeader.match(/filename="?([^";]+)"?/i);
          if (cdMatch) {
            try { realFilename = decodeURIComponent(cdMatch[1]); } catch (e) { realFilename = cdMatch[1]; }
          }
        }
        if (!realFilename) {
          const urlSegments = location.split('?')[0].split('/');
          const encodedName = urlSegments[urlSegments.length - 1];
          try { realFilename = encodedName ? decodeURIComponent(encodedName) : ''; } catch (e) { realFilename = encodedName; }
        }

        return {
          success: true,
          downloadUrl: location,
          sha1: sha1Match ? sha1Match[1] : '',
          fileId: '', // 注意：CDN URL 中的 vip-xxxx- 不是网盘内的真实 file_id，置空交由 resolveFileOnCookie 解析
          filename: realFilename,
          uid: uMatch ? uMatch[1] : '',
          pickcode
        };
      }
    } catch (e) {
      if (e.response && e.response.headers && e.response.headers.location) {
        const location = e.response.headers.location;
        const sha1Match = location.match(/115cdn\.net\/([a-f0-9]{40})\//i);
        const uMatch = location.match(/[?&]u=(\d+)/);
        const cdHeader = (e.response.headers && e.response.headers['content-disposition']) || '';
        let realFilename = '';
        if (cdHeader) {
          const cdMatch = cdHeader.match(/filename\*=UTF-8''([^;]+)/i) || cdHeader.match(/filename="?([^";]+)"?/i);
          if (cdMatch) {
            try { realFilename = decodeURIComponent(cdMatch[1]); } catch (err) { realFilename = cdMatch[1]; }
          }
        }
        if (!realFilename) {
          const urlSegments = location.split('?')[0].split('/');
          const encodedName = urlSegments[urlSegments.length - 1];
          try { realFilename = encodedName ? decodeURIComponent(encodedName) : ''; } catch (err) { realFilename = encodedName; }
        }

        return {
          success: true,
          downloadUrl: location,
          sha1: sha1Match ? sha1Match[1] : '',
          fileId: '',
          filename: realFilename,
          uid: uMatch ? uMatch[1] : '',
          pickcode
        };
      }
      return { success: false, error: e.message };
    }
    return { success: false, error: '未能从源盘节点解析到重定向直链' };
  }

  /**
   * 通用直链获取接口 (优先小号自身 Cookie 签名)
   */
  async getDirectLink(cookie, pickcode, fileId = '', clientUserAgent = '') {
    if (cookie) {
      return this.getUserDirectLink(cookie, pickcode, fileId, clientUserAgent);
    }
    return this.getSourceDirectLink(pickcode, clientUserAgent);
  }

  /**
   * 6. 115 账号间官方分享与转存 (核心隔离机制：将源盘文件瞬间秒传复制到小号的指定目录)
   */
  async shareAndReceiveFile(sourceCookie, receiverCookie, fileId, targetCid = '0', filename = '') {
    if (!sourceCookie || !receiverCookie || !fileId) {
      return { success: false, error: '缺少转存必要参数 (sourceCookie, receiverCookie 或 fileId)' };
    }

    try {
      // 1. 源账号创建复制分享 (share_to: 'copy' 为私密复制分享)
      const sendRes = await this.http.post(
        'https://webapi.115.com/share/send',
        new URLSearchParams({
          file_ids: String(fileId),
          share_to: 'copy'
        }).toString(),
        {
          headers: {
            Cookie: sourceCookie,
            Referer: 'https://115.com/',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT
          },
          timeout: 6000
        }
      );

      let shareCode = '';
      let receiveCode = '';

      if (sendRes.data && sendRes.data.state && sendRes.data.data) {
        shareCode = sendRes.data.data.share_code;
        receiveCode = sendRes.data.data.receive_code;
      } else {
        const errMsg = sendRes.data ? (sendRes.data.msg || sendRes.data.error || '创建分享链接失败') : '源盘响应异常';
        return { success: false, error: `源盘分享失败: ${errMsg}` };
      }

      if (!shareCode || !receiveCode) {
        return { success: false, error: '未能获取到有效分享码或提取码' };
      }

      // 2. 小号接收转存至其指定的秒存目录
      const cleanCid = String(targetCid || '0');
      const receiveRes = await this.http.post(
        'https://webapi.115.com/share/receive',
        new URLSearchParams({
          share_code: shareCode,
          receive_code: receiveCode,
          cid: cleanCid,
          file_id: String(fileId)
        }).toString(),
        {
          headers: {
            Cookie: receiverCookie,
            Referer: 'https://115.com/',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT
          },
          timeout: 8000
        }
      );

      if (!receiveRes.data || !receiveRes.data.state) {
        const errMsg = receiveRes.data ? (receiveRes.data.msg || receiveRes.data.error || '转存请求失败') : '转存响应异常';
        return { success: false, error: `小号转存失败: ${errMsg}` };
      }

      // 3. 转存成功后，从小号目标目录或搜索获取新生成的文件 pickcode
      let newPickcode = '';
      let newFileId = '';

      try {
        const listUrl = `https://webapi.115.com/files?aid=1&cid=${encodeURIComponent(cleanCid)}&show_dir=0&limit=20&format=json&o=user_ptime&asc=0`;
        const listRes = await this.http.get(listUrl, {
          headers: {
            Cookie: receiverCookie,
            Referer: 'https://115.com/',
            'User-Agent': USER_AGENT
          },
          timeout: 5000
        });

        if (listRes.data && listRes.data.state && Array.isArray(listRes.data.data) && listRes.data.data.length > 0) {
          let matched = null;
          if (filename) {
            matched = listRes.data.data.find(f => f.n === filename || f.n.includes(filename) || filename.includes(f.n));
          }
          if (!matched) matched = listRes.data.data[0];
          if (matched && matched.pc) {
            newPickcode = matched.pc;
            newFileId = matched.fid;
          }
        }
      } catch (e) {
        console.warn('[115] 查验转存目录文件异常:', e.message);
      }

      // 若目录列出未拿到，备用按文件名在小号盘内检索
      if (!newPickcode && filename) {
        const search = await this.searchUserDrive(receiverCookie, filename);
        if (search.found && search.pickcode) {
          newPickcode = search.pickcode;
          newFileId = search.fileId;
        }
      }

      return {
        success: true,
        pickcode: newPickcode,
        fileId: newFileId,
        targetCid: cleanCid,
        msg: '转存秒传成功'
      };
    } catch (e) {
      console.error('❌ [115] 分享转存异常:', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * 7. 确保用户的秒存目录存在 (若不存在则自动在根目录下创建)
   */
  async ensureCacheDirectory(cookie, pathStr = '/EmbyCache') {
    if (!cookie) return { success: false, error: '缺少 Cookie' };
    const cleanName = pathStr.replace(/^\/+/, '').split('/')[0] || 'EmbyCache';

    try {
      const dirs = await this.getDirectories(cookie, '0');
      if (dirs.success && Array.isArray(dirs.folders)) {
        const existing = dirs.folders.find(f => f.name === cleanName);
        if (existing && existing.cid) {
          return { success: true, cid: String(existing.cid), name: cleanName };
        }
      }

      // 未找到则自动在根目录创建
      const created = await this.createDirectory(cookie, '0', cleanName);
      if (created.success && created.cid) {
        return { success: true, cid: String(created.cid), name: cleanName };
      }
      return { success: false, error: created.error || '自动创建缓存目录失败' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 6. 在指定用户的网盘中根据关键词或文件名智能查询文件 (严格关键词过滤，杜绝张冠李戴)
   */
  async searchUserDrive(cookie, query) {
    if (!cookie || !query) return { found: false };

    // 过滤异常查询：若为 redirect_url 或仅有 pickcode 参数，不执行网盘搜索
    if (query.includes('redirect_url') || query.includes('pickcode=') || query.startsWith('http')) {
      return { found: false };
    }

    // 清洗提取纯净标题与核心关键词
    const cleanQuery = query
      .replace(/\.[a-zA-Z0-9]+$/, '')
      .replace(/\((?:19|20)\d{2}\)/g, ' ')
      .replace(/\b(?:2160p|1080p|720p|4k|remux|web-dl|hdr|dovi|dv|h265|x265|hevc|aac|ddp\d(?:\.\d)?)\b/gi, ' ')
      .replace(/[:：_\-\[\]\(\)]+/g, ' ')
      .trim();

    const candidateQueries = [];
    if (cleanQuery && cleanQuery.length >= 2) candidateQueries.push(cleanQuery);
    const mainTitle = cleanQuery.split(/\s+/)[0];
    if (mainTitle && mainTitle.length >= 2 && !candidateQueries.includes(mainTitle)) {
      candidateQueries.push(mainTitle);
    }
    if (query !== cleanQuery && !candidateQueries.includes(query)) {
      candidateQueries.push(query);
    }

    // 校验候选文件名是否真实命中目标标题（防止 115 模糊检索出毫无关联的文件）
    const isTargetMatch = (itemName, targetTitle) => {
      if (!itemName || !targetTitle) return false;
      const normalize = s => s.toLowerCase().replace(/[:：_\-\s\[\]\(\)\.]+/g, '');
      const itemNorm = normalize(itemName);
      const titleNorm = normalize(targetTitle);
      return itemNorm.includes(titleNorm) || titleNorm.includes(itemNorm);
    };

    for (const q of candidateQueries) {
      try {
        const url = `https://webapi.115.com/files/search?search_value=${encodeURIComponent(q)}&cid=0&limit=10&format=json`;
        const res = await this.http.get(url, {
          headers: {
            Cookie: cookie,
            Referer: 'https://115.com/',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          timeout: 4000
        });

        if (res.data && res.data.state && res.data.data && Array.isArray(res.data.data) && res.data.data.length > 0) {
          // 严格匹配：候选文件必须包含当前搜索核心标题或原始主标题，避免无关文件干扰
          const matchedItem = res.data.data.find(item => {
            if (!item.pc) return false;
            return isTargetMatch(item.n, mainTitle || cleanQuery);
          });

          if (matchedItem && matchedItem.pc) {
            return {
              found: true,
              pickcode: matchedItem.pc,
              fileId: matchedItem.fid,
              filename: matchedItem.n,
              filesize: matchedItem.s,
              sha1: matchedItem.sha1 || matchedItem.sha
            };
          }
        }
      } catch (e) {
        // 单个查询异常则尝试下一个候选词
      }
    }

    return { found: false };
  }

  /**
   * 在指定 115 账号中定位文件，获取该账号下真实的 file_id 与 pickcode
   */
  async resolveFileOnCookie(cookie, pickcode = '', filename = '', sha1 = '') {
    if (!cookie) return { found: false };

    // 1. 若有 pickcode，优先通过 downurl 探测该账号是否直接拥有该文件 (100% 准确提取该账号所属真实 file_id)
    if (pickcode) {
      try {
        const url = `https://proapi.115.com/app/chrome/downurl?pickcode=${pickcode}`;
        const res = await this.http.get(url, {
          headers: {
            Cookie: cookie,
            Referer: 'https://115.com/',
            'User-Agent': USER_AGENT
          },
          timeout: 4000
        });

        if (res.data && res.data.state && res.data.data) {
          const keys = Object.keys(res.data.data);
          if (keys.length > 0) {
            const fid = keys[0];
            const fileObj = res.data.data[fid];
            if (fileObj && fileObj.url && fileObj.url.url) {
              const uMatch = fileObj.url.url.match(/[?&]u=(\d+)/);
              return {
                found: true,
                fileId: fid,
                pickcode: fileObj.pick_code || pickcode,
                filename: fileObj.file_name || filename,
                filesize: fileObj.file_size || 0,
                downloadUrl: fileObj.url.url,
                uid: uMatch ? uMatch[1] : ''
              };
            }
          }
        }
      } catch (e) {}
    }

    // 2. 若 pickcode 未直接命中，通过有效文件名在指定账号网盘中精确搜索匹配真实 file_id
    if (filename && !filename.includes('redirect_url') && !filename.includes('pickcode=')) {
      const searchRes = await this.searchUserDrive(cookie, filename);
      if (searchRes.found && searchRes.fileId) {
        return {
          found: true,
          fileId: searchRes.fileId,
          pickcode: searchRes.pickcode,
          filename: searchRes.filename || filename,
          filesize: searchRes.filesize || 0,
          sha1: searchRes.sha1 || sha1
        };
      }
    }

    return { found: false };
  }

  /**
   * 7. 获取指定 cid 目录下的子文件夹列表与路径信息
   */
  async getDirectories(cookie, cid = '0') {
    if (!cookie) return { success: false, error: '缺少 115 Cookie' };

    try {
      const targetCid = String(cid || '0');
      const url = `https://webapi.115.com/files?aid=1&cid=${encodeURIComponent(targetCid)}&show_dir=1&limit=200&format=json`;
      const res = await this.http.get(url, {
        headers: {
          Cookie: cookie,
          Referer: 'https://115.com/',
          'User-Agent': USER_AGENT
        },
        timeout: 6000
      });

      if (res.data && res.data.state) {
        const rawData = res.data.data || [];
        // 过滤出文件夹：115 文件夹一般没有 fid (只有 cid)，或者 ico === 'folder'
        const folders = rawData
          .filter(item => {
            if (item.fid) return false;
            return Boolean(item.cid);
          })
          .map(item => ({
            cid: String(item.cid),
            name: item.n || item.name || '未命名文件夹',
            pid: String(item.pid || targetCid),
            count: typeof item.fc !== 'undefined' ? item.fc : 0,
            updatedAt: item.t || ''
          }));

        // 解析面包屑路径
        let path = [];
        if (Array.isArray(res.data.path) && res.data.path.length > 0) {
          path = res.data.path.map(p => ({
            cid: String(p.cid),
            name: p.name || (String(p.cid) === '0' ? '根目录' : String(p.cid))
          }));
        } else {
          path = [{ cid: '0', name: '根目录' }];
        }

        // 计算当前完整绝对路径字符串
        const pathParts = path.map(p => p.name).filter(n => n && n !== '根目录');
        const fullPath = pathParts.length > 0 ? '/' + pathParts.join('/') : '/';

        return {
          success: true,
          cid: targetCid,
          fullPath,
          path,
          folders
        };
      }

      return {
        success: false,
        error: res.data ? (res.data.msg || res.data.error || '获取网盘目录失败') : '上游返回为空'
      };
    } catch (e) {
      console.error('❌ [115] 获取目录列表失败:', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * 8. 在指定目录下创建新文件夹
   */
  async createDirectory(cookie, pid = '0', name) {
    if (!cookie) return { success: false, error: '缺少 115 Cookie' };
    if (!name || !name.trim()) return { success: false, error: '文件夹名称不能为空' };

    try {
      const res = await this.http.post(
        'https://webapi.115.com/files/add',
        new URLSearchParams({
          pid: String(pid || '0'),
          cname: name.trim()
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookie,
            Referer: 'https://115.com/',
            'User-Agent': USER_AGENT
          },
          timeout: 6000
        }
      );

      if (res.data && (res.data.state === true || res.data.status === true)) {
        const fileId = res.data.data ? (res.data.data.file_id || res.data.data.cid || res.data.data.category_id) : '';
        return {
          success: true,
          cid: String(fileId || ''),
          name: name.trim()
        };
      }

      return {
        success: false,
        error: res.data ? (res.data.error || res.data.msg || '创建文件夹失败') : '创建失败'
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

const openApi115 = new OpenApi115();

module.exports = openApi115;
