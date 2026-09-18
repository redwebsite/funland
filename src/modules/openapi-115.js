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
   * 4. 获取下载直链
   */
  async getDirectLink(cookie, pickcode, fileId = '') {
    if (!pickcode) return { success: false, error: '缺少 pickcode' };

    // 1. 优先通过系统直链服务节点解析（绕过 115 客户端私有 RSA 签名限制）
    try {
      const helperUrl = `http://158.101.5.12:65041/api/v1/plugin/P115StrmHelper/redirect_url?pickcode=${pickcode}`;
      const res = await this.http.get(helperUrl, {
        maxRedirects: 0,
        validateStatus: s => s >= 200 && s < 400,
        timeout: 4000
      });
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        return {
          success: true,
          downloadUrl: res.headers.location,
          fileId: fileId || pickcode,
          pickcode
        };
      }
    } catch (e) {
      if (e.response && e.response.headers && e.response.headers.location) {
        return {
          success: true,
          downloadUrl: e.response.headers.location,
          fileId: fileId || pickcode,
          pickcode
        };
      }
    }

    // 2. 备用通过 115 官方 Chrome 接口尝试提取
    try {
      const url = `https://proapi.115.com/app/chrome/downurl?pickcode=${pickcode}`;
      const res = await this.http.get(url, {
        headers: {
          Cookie: cookie,
          Referer: 'https://115.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        timeout: 4000
      });

      if (res.data && res.data.state && res.data.data) {
        const fileObj = fileId ? res.data.data[fileId] : Object.values(res.data.data)[0];
        if (fileObj && fileObj.url && fileObj.url.url) {
          return {
            success: true,
            downloadUrl: fileObj.url.url,
            fileId: fileId || Object.keys(res.data.data)[0],
            filename: fileObj.file_name || ''
          };
        }
      }
      return { success: false, error: '无法从 115 解析到直链地址' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 5. 按 SHA1 秒传转存文件到用户指定目录
   */
  async fastTransfer(cookie, sha1, filesize, filename, targetCid = 0) {
    try {
      const res = await this.http.post(
        'https://uplb.115.com/3.0/initupload.php',
        new URLSearchParams({
          appid: '0',
          appversion: '30.8.0',
          fileid: sha1,
          filesize: String(filesize),
          filename: filename,
          target: `U_1_${targetCid}`
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: cookie
          }
        }
      );

      if (res.data && (res.data.status === 2 || res.data.status === '2')) {
        // status 2 表示秒传完成
        return {
          success: true,
          pickcode: res.data.pickcode || '',
          fileId: res.data.fileid || '',
          msg: '秒传转存成功'
        };
      }
      return {
        success: false,
        msg: res.data ? res.data.message || '文件未在115云端命中秒传' : '未知响应'
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 6. 在指定用户的网盘中根据 SHA1 或文件名查询文件
   */
  async searchUserDrive(cookie, query) {
    if (!cookie || !query) return { found: false };

    // 生成搜索候选词：优先原始关键词，其次去除特殊符号与扩展名的纯净关键词
    const cleanQuery = query.replace(/\.[a-zA-Z0-9]+$/, '').replace(/[:：_\-\[\]\(\)]+/g, ' ').trim();
    const candidateQueries = [query];
    if (cleanQuery && cleanQuery !== query && !candidateQueries.includes(cleanQuery)) {
      candidateQueries.push(cleanQuery);
    }
    const mainTitle = cleanQuery.split(/\s+/)[0];
    if (mainTitle && mainTitle.length >= 2 && !candidateQueries.includes(mainTitle)) {
      candidateQueries.push(mainTitle);
    }

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
          // 优先寻找视频文件（过滤非视频类型，优先含 pickcode 的文件）
          const videoItem = res.data.data.find(item => item.pc && (item.sha1 || item.sha || item.s > 0)) || res.data.data[0];
          if (videoItem && videoItem.pc) {
            return {
              found: true,
              pickcode: videoItem.pc,
              fileId: videoItem.fid,
              filename: videoItem.n,
              filesize: videoItem.s,
              sha1: videoItem.sha1 || videoItem.sha
            };
          }
        }
      } catch (e) {
        // 单个查询异常则尝试下一个候选词
      }
    }

    return { found: false };
  }
}

const openApi115 = new OpenApi115();

module.exports = openApi115;
