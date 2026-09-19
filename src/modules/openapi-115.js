const axios = require('axios');
const qrcode = require('qrcode');
const crypto = require('node:crypto');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ============================================================
// 115 Chrome/App 官方协议加解密核心 (RSA + 自定义 XOR 算法，移植自 fake115)
// ============================================================
function modPow(base, exp, mod) {
  let res = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) res = (res * base) % mod;
    base = (base * base) % mod;
    exp = exp / 2n;
  }
  return res;
}

class M115Rsa {
  constructor() {
    this.n = BigInt('0x8686980c0f5a24c4b9d43020cd2c22703ff3f450756529058b1cf88f09b8602136477198a6e2683149659bd122c33592fdb5ad47944ad1ea4d36c6b172aad6338c3bb6ac6227502d010993ac967d1aef00f0c8e038de2e4d3bc2ec368af2e9f10a6f1eda4f7262f136420c07c331b871bf139f74f3010e3c4fe57df3afb71683');
    this.e = BigInt('0x10001');
  }
  a2hex(b) {
    return b.map(x => x.toString(16).padStart(2, '0')).join('');
  }
  hex2a(hex) {
    let s = '';
    for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return s;
  }
  pkcs1pad2(s, n) {
    const ba = new Array(n).fill(0);
    let i = s.length - 1, idx = n;
    while (i >= 0) ba[--idx] = s.charCodeAt(i--);
    ba[--idx] = 0;
    while (idx > 2) ba[--idx] = 0xff;
    ba[--idx] = 2;
    return BigInt('0x' + this.a2hex(ba));
  }
  pkcs1unpad2(a) {
    let b = a.toString(16);
    if (b.length % 2) b = '0' + b;
    const c = this.hex2a(b);
    let i = 1;
    while (i < c.length && c.charCodeAt(i) !== 0) i++;
    return c.slice(i + 1);
  }
  encrypt(text) {
    const m = this.pkcs1pad2(text, 0x80);
    const c = modPow(m, this.e, this.n);
    return c.toString(16).padStart(0x80 * 2, '0');
  }
  decrypt(text) {
    const ba = [...text].map((_, i) => text.charCodeAt(i));
    const a = BigInt('0x' + this.a2hex(ba));
    const c = modPow(a, this.e, this.n);
    return this.pkcs1unpad2(c);
  }
}

const rsa115 = new M115Rsa();
const G_KTS = [240,229,105,174,191,220,191,138,26,69,232,190,125,166,115,184,222,143,231,196,69,218,134,196,155,100,139,20,106,180,241,170,56,1,53,158,38,105,44,134,0,107,79,165,54,52,98,166,42,150,104,24,242,74,253,189,107,151,143,77,143,137,19,183,108,142,147,237,14,13,72,62,215,47,136,216,254,254,126,134,80,149,79,209,235,131,38,52,219,102,123,156,126,157,122,129,50,234,182,51,222,58,169,89,52,102,59,170,186,129,96,72,185,213,129,156,248,108,132,119,255,84,120,38,95,190,232,30,54,159,52,128,92,69,44,155,118,213,27,143,204,195,184,245];
const G_KEY_S = [0x29, 0x23, 0x21, 0x5E];
const G_KEY_L = [120,6,173,76,51,134,93,24,76,1,63,70];

function m115GetKey(length, key) {
  if (key) return Array.from({length}, (_, i) => ((key[i] + G_KTS[length * i]) & 0xff) ^ G_KTS[length * (length - 1 - i)]);
  return (length === 12 ? G_KEY_L : G_KEY_S).slice();
}

function xor115Enc(src, key) {
  const srclen = src.length, keylen = key.length;
  const mod4 = srclen % 4;
  const ret = [];
  for (let i = 0; i < mod4; i++) ret.push(src[i] ^ key[i % keylen]);
  for (let i = mod4; i < srclen; i++) ret.push(src[i] ^ key[(i - mod4) % keylen]);
  return ret;
}

function m115SymEncode(src, key1, key2) {
  let ret = xor115Enc(src, m115GetKey(4, key1));
  ret.reverse();
  return xor115Enc(ret, m115GetKey(12, key2));
}

function m115SymDecode(src, key1, key2) {
  let ret = xor115Enc(src, m115GetKey(12, key2));
  ret.reverse();
  return xor115Enc(ret, m115GetKey(4, key1));
}

function strToBytes(s) { return [...s].map(c => c.charCodeAt(0)); }
function bytesToStr(b) { return b.map(c => String.fromCharCode(c)).join(''); }

function m115AsymEncode(src) {
  const m = 128 - 11;
  let ret = '';
  for (let i = 0; i < Math.ceil(src.length / m); i++) {
    ret += rsa115.encrypt(bytesToStr(src.slice(i * m, Math.min((i + 1) * m, src.length))));
  }
  return Buffer.from(rsa115.hex2a(ret), 'latin1').toString('base64');
}

function m115AsymDecode(src) {
  const m = 128;
  const buf = Buffer.from(src, 'base64').toString('latin1');
  let ret = '';
  for (let i = 0; i < Math.ceil(buf.length / m); i++) {
    ret += rsa115.decrypt(buf.slice(i * m, Math.min((i + 1) * m, buf.length)));
  }
  return strToBytes(ret);
}

function m115Md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function m115Encode(src, tm) {
  const key = strToBytes(m115Md5('!@###@#' + tm + 'DFDR@#@#'));
  let tmp = strToBytes(src);
  tmp = m115SymEncode(tmp, key, null);
  tmp = key.slice(0, 16).concat(tmp);
  return { data: m115AsymEncode(tmp), key };
}

function m115Decode(src, key) {
  let tmp = m115AsymDecode(src);
  return bytesToStr(m115SymDecode(tmp.slice(16), key, tmp.slice(0, 16)));
}

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

    const ua = clientUserAgent || USER_AGENT;

    // 1. 优先使用 115 Chrome/App 官方协议接口 (proapi downurl + RSA+XOR)，无文件大小限制，100% 返回真实直链
    try {
      const tm = Math.floor(Date.now() / 1000);
      const enc = m115Encode(JSON.stringify({ pickcode }), tm);
      const postBody = new URLSearchParams({ data: enc.data }).toString();

      const res = await this.http.post(`https://proapi.115.com/app/chrome/downurl?t=${tm}`, postBody, {
        headers: {
          Cookie: cookie,
          Referer: 'https://115.com/',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': ua
        },
        timeout: 6000
      });

      if (res.data && res.data.state && res.data.data) {
        let dataObj = null;
        if (typeof res.data.data === 'string') {
          try {
            const decrypted = m115Decode(res.data.data, enc.key);
            dataObj = JSON.parse(decrypted);
          } catch (decErr) {
            console.warn('[115] proapi downurl 解密异常:', decErr.message);
          }
        } else if (typeof res.data.data === 'object') {
          dataObj = res.data.data;
        }

        if (dataObj && typeof dataObj === 'object') {
          const fileObj = fileId ? dataObj[fileId] : Object.values(dataObj)[0];
          const directUrl = fileObj && fileObj.url && (fileObj.url.url || fileObj.url);
          if (directUrl && typeof directUrl === 'string') {
            const uMatch = directUrl.match(/[?&]u=(\d+)/);
            return {
              success: true,
              downloadUrl: directUrl,
              fileId: fileId || Object.keys(dataObj)[0],
              filename: fileObj.file_name || '',
              filesize: fileObj.file_size || 0,
              pickcode,
              uid: uMatch ? uMatch[1] : ''
            };
          }
        }
      }
    } catch (e) {
      console.warn('[115] proapi downurl 官方协议解析尝试失败:', e.message);
    }

    // 2. 备用方式一：调用 webapi.115.com/files/download
    try {
      const webRes = await this.http.get(`https://webapi.115.com/files/download?pickcode=${pickcode}&dl=1`, {
        headers: {
          Cookie: cookie,
          Referer: 'https://115.com/',
          'User-Agent': ua
        },
        timeout: 5000
      });

      if (webRes.data && webRes.data.state && (webRes.data.file_url || webRes.data.file_url_302)) {
        const directUrl = webRes.data.file_url || webRes.data.file_url_302;
        const uMatch = directUrl.match(/[?&]u=(\d+)/);
        return {
          success: true,
          downloadUrl: directUrl,
          fileId: fileId || webRes.data.file_id || '',
          filename: webRes.data.file_name || '',
          filesize: webRes.data.file_size || 0,
          pickcode,
          uid: uMatch ? uMatch[1] : ''
        };
      }
    } catch (e) {}

    // 3. 备用方式二：调用 webapi.115.com/files/video
    try {
      const vidRes = await this.http.get(`https://webapi.115.com/files/video?pickcode=${pickcode}`, {
        headers: {
          Cookie: cookie,
          Referer: 'https://115.com/',
          'User-Agent': ua
        },
        timeout: 5000
      });

      if (vidRes.data && vidRes.data.video_url && Array.isArray(vidRes.data.video_url) && vidRes.data.video_url.length > 0) {
        const directUrl = vidRes.data.video_url[0].url;
        const uMatch = directUrl ? directUrl.match(/[?&]u=(\d+)/) : null;
        return {
          success: true,
          downloadUrl: directUrl,
          fileId: fileId || vidRes.data.file_id || '',
          filename: vidRes.data.file_name || '',
          filesize: vidRes.data.file_size || 0,
          pickcode,
          uid: uMatch ? uMatch[1] : ''
        };
      }
    } catch (e) {}

    return {
      success: false,
      error: '未能从小号 Cookie 解析到 115 官方直链（可能是账号未存该文件或 Cookie 权限受限）'
    };
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
  async shareAndReceiveFile(sourceCookie, receiverCookie, fileId, targetCid = '0', filename = '', expectedSha1 = '') {
    if (!sourceCookie || !receiverCookie || !fileId) {
      return { success: false, error: '缺少转存必要参数 (sourceCookie, receiverCookie 或 fileId)' };
    }

    try {
      // 1. 源账号创建复制分享 (share_to: 'copy' 为私密复制分享)
      const sendRes = await this.http.post(
        'https://webapi.115.com/share/send',
        new URLSearchParams({
          file_ids: String(fileId),
          share_to: 'copy',
          ignore_warn: '1'
        }).toString(),
        {
          headers: {
            Cookie: sourceCookie,
            Referer: 'https://115.com/',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT
          },
          timeout: 8000
        }
      );

      let shareCode = '';
      let receiveCode = '';

      if (sendRes.data && sendRes.data.state && sendRes.data.data) {
        const d = sendRes.data.data;
        shareCode = d.share_code || d.sharecode || d.snap_code || d.code || '';
        receiveCode = d.receive_code || d.receivecode || d.password || d.pwd || '';

        const shareUrl = d.share_url || d.url || '';
        if (shareUrl) {
          const match = shareUrl.match(/\/s\/([a-z0-9]+)(?:\?password=([a-z0-9]+))?/i);
          if (match) {
            if (!shareCode) shareCode = match[1];
            if (!receiveCode && match[2]) receiveCode = match[2];
          }
        }
      } else {
        const errMsg = sendRes.data ? (sendRes.data.msg || sendRes.data.error || '创建分享链接失败') : '源盘响应异常';
        return { success: false, error: `源盘分享失败: ${errMsg}` };
      }

      if (!shareCode) {
        return { success: false, error: `未能获取到有效分享码: ${JSON.stringify(sendRes.data)}` };
      }

      // 2. 小号接收转存至其指定的秒存目录
      const cleanCid = String(targetCid || '0');
      const uidMatch = receiverCookie.match(/(?:^|;\s*)UID=([^;]+)/i);
      const receiverUid = uidMatch ? uidMatch[1] : '';

      const postParams = new URLSearchParams({
        share_code: shareCode,
        receive_code: receiveCode || '',
        cid: cleanCid,
        file_id: String(fileId),
        file_ids: String(fileId)
      });
      if (receiverUid) {
        postParams.append('user_id', receiverUid);
      }

      const doReceive = async () => {
        return await this.http.post(
          'https://webapi.115.com/share/receive',
          postParams.toString(),
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
      };

      let receiveRes = await doReceive();

      // 若遇 115 后台正在生成文件快照，自动等待 1.8 秒后重试接收
      if (!receiveRes.data || !receiveRes.data.state) {
        const errMsg = receiveRes.data ? (receiveRes.data.msg || receiveRes.data.error || '') : '';
        if (errMsg.includes('快照') || errMsg.includes('生成文件快照')) {
          console.log(`⏳ [115] 115 正在生成文件快照，等待 1.8 秒后自动重试接收...`);
          await new Promise(r => setTimeout(r, 1800));
          receiveRes = await doReceive();
        }
      }

      if (!receiveRes.data || !receiveRes.data.state) {
        const errCode = receiveRes.data && (receiveRes.data.errno || receiveRes.data.code);
        const errMsg = receiveRes.data ? (receiveRes.data.msg || receiveRes.data.error || '') : '转存响应异常';
        if (errCode === 4100024 || (errMsg && (errMsg.includes('已经接收') || errMsg.includes('无需重复') || errMsg.includes('已转存')))) {
          console.log(`ℹ️ [115] 该文件小号已接收过，继续获取其 Pickcode`);
        } else {
          return { success: false, error: `小号转存失败: ${errMsg || errCode || JSON.stringify(receiveRes.data)}` };
        }
      }

      // 3. 转存成功后，从小号目标目录获取新生成文件的 pickcode
      let newPickcode = '';
      let newFileId = '';

      const checkTargetDir = async () => {
        try {
          // 扩大 limit 到 100，确保在已有文件较多时也能精准检索到刚转存的文件
          const listUrl = `https://webapi.115.com/files?aid=1&cid=${encodeURIComponent(cleanCid)}&show_dir=0&limit=100&format=json&o=user_ptime&asc=0`;
          const listRes = await this.http.get(listUrl, {
            headers: {
              Cookie: receiverCookie,
              Referer: 'https://115.com/',
              'User-Agent': USER_AGENT
            },
            timeout: 6000
          });

          if (listRes.data && listRes.data.state && Array.isArray(listRes.data.data) && listRes.data.data.length > 0) {
            let matched = null;
            // 1. 优先根据 SHA1 精准比对 (指纹相同 100% 为目标文件)
            if (expectedSha1) {
              matched = listRes.data.data.find(f => {
                const s = f.sha1 || f.sha || '';
                return s && s.toLowerCase() === expectedSha1.toLowerCase();
              });
            }
            // 2. 备用根据文件名结构化严格比对 (坚决杜绝 fallback 到 data[0] 张冠李戴)
            if (!matched && filename) {
              matched = listRes.data.data.find(f => {
                const n = f.n || f.file_name || '';
                return n === filename || this.isTargetMatch(n, filename);
              });
            }
            if (matched) {
              const pc = matched.pc || matched.pick_code || matched.pickcode;
              if (pc) {
                return {
                  pc,
                  fid: String(matched.fid || matched.file_id || ''),
                  name: matched.n || matched.file_name || ''
                };
              }
            }
          }
        } catch (e) {
          console.warn('[115] 查验转存目录文件异常:', e.message);
        }
        return null;
      };

      // 渐进式智能轮询：115 接收转存后落盘通常需要 1~3 秒
      // 分别在 600ms, 1200ms, 1800ms, 2500ms 尝试，只要落盘立即返回
      const pollDelays = [600, 1200, 1800, 2500];
      for (const delay of pollDelays) {
        await new Promise(r => setTimeout(r, delay));
        const dirHit = await checkTargetDir();
        if (dirHit) {
          newPickcode = dirHit.pc;
          newFileId = dirHit.fid;
          break;
        }
      }

      // 若指定 cid 目录内仍未拿到，尝试按文件名在小号全盘内严格检索
      if (!newPickcode && filename) {
        const search = await this.searchUserDrive(receiverCookie, filename);
        if (search.found && search.pickcode) {
          newPickcode = search.pickcode;
          newFileId = search.fileId;
        }
      }

      if (!newPickcode) {
        return {
          success: false,
          error: `转存已提交，但未能在小号目录中确认落盘目标文件 ("${filename || fileId}")`
        };
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
   * 6. 在指定用户的网盘中根据关键词、文件名或 pickcode 智能查询文件 (严格结构化匹配，彻底杜绝张冠李戴)
   */
  async searchUserDrive(cookie, query, targetEpisode = null) {
    if (!cookie || !query) return { found: false };

    // 过滤异常查询：若为 redirect_url 或带有明显 URL 协议参数，不执行网盘搜索
    if (query.includes('redirect_url') || query.startsWith('http')) {
      return { found: false };
    }

    const trimmedQuery = query.trim();

    // 1. 若 query 本身是 pickcode (15-20位字母数字组合)，直接通过 pickcode 精确搜索
    if (/^[a-z0-9]{15,20}$/i.test(trimmedQuery)) {
      try {
        const url = `https://webapi.115.com/files/search?aid=1&cid=0&search_value=${encodeURIComponent(trimmedQuery)}&limit=10&format=json`;
        const res = await this.http.get(url, {
          headers: {
            Cookie: cookie,
            Referer: 'https://115.com/',
            'User-Agent': USER_AGENT
          },
          timeout: 5000
        });

        if (res.data && res.data.state && res.data.data && Array.isArray(res.data.data)) {
          const matched = res.data.data.find(it => (it.pc || it.pick_code || it.pickcode) === trimmedQuery);
          if (matched) {
            return {
              found: true,
              pickcode: trimmedQuery,
              fileId: String(matched.fid || matched.file_id),
              filename: matched.n || matched.file_name,
              filesize: matched.s || matched.file_size || 0,
              sha1: matched.sha1 || matched.sha || ''
            };
          }
        }
      } catch (e) {}
    }

    const parsed = this.parseQuery(trimmedQuery, targetEpisode);
    const subTitles = (parsed.title || '').split(/[\/／]/).map(s => s.trim()).filter(s => s.length >= 2);

    // 构建精准搜索候选词序列
    const candidateQueries = [];
    if (parsed.isSeries && parsed.episode !== null) {
      const ep2 = String(parsed.episode).padStart(2, '0');
      for (const st of subTitles) {
        candidateQueries.push(`${st} E${ep2}`);
        candidateQueries.push(`${st} 第${parsed.episode}集`);
        candidateQueries.push(st);
      }
    } else {
      for (const st of subTitles) {
        candidateQueries.push(st);
      }
    }
    if (parsed.title && !candidateQueries.includes(parsed.title)) {
      candidateQueries.push(parsed.title);
    }

    for (const q of candidateQueries) {
      try {
        // 核心修复：115 官方检索 API 必须携带 aid=1，否则返回登录超时或参数错误
        const url = `https://webapi.115.com/files/search?aid=1&cid=0&search_value=${encodeURIComponent(q)}&limit=30&format=json`;
        const res = await this.http.get(url, {
          headers: {
            Cookie: cookie,
            Referer: 'https://115.com/',
            'User-Agent': USER_AGENT
          },
          timeout: 5000
        });

        if (res.data && res.data.state && res.data.data && Array.isArray(res.data.data) && res.data.data.length > 0) {
          const matchedItem = res.data.data.find(item => {
            const pc = item.pc || item.pick_code || item.pickcode;
            if (!pc) return false;
            const name = item.n || item.file_name || '';
            // 若直接搜 pickcode 命中
            if (pc === q) return true;
            return this.isTargetMatch(name, trimmedQuery, targetEpisode);
          });

          if (matchedItem) {
            const fid = matchedItem.fid || matchedItem.file_id;
            const pc = matchedItem.pc || matchedItem.pick_code || matchedItem.pickcode;
            const name = matchedItem.n || matchedItem.file_name;
            const size = matchedItem.s || matchedItem.file_size || 0;
            const sha1 = matchedItem.sha1 || matchedItem.sha || '';
            return {
              found: true,
              pickcode: pc,
              fileId: String(fid),
              filename: name,
              filesize: size,
              sha1
            };
          }
        }
      } catch (e) {
        // 单个查询异常则尝试下一个候选词
      }
    }

    return { found: false };
  }

  // 提取剧集集数 (例如 S01E02, E02, 第2集, EP02)
  extractEpisode(s) {
    if (!s) return null;
    const m = s.match(/(?:s\d+)?e(\d+)/i) || s.match(/(?:ep|第)\s*(\d+)\s*(?:集)?/i);
    return m ? parseInt(m[1], 10) : null;
  }

  // 规范化字符串用于严格比对
  normalize(s) {
    return (s || '').toLowerCase().replace(/[:：_\-\s\[\]\(\)\.\/／]+/g, '');
  }

  // 智能解析媒体名称结构
  parseQuery(raw, targetEpisode = null) {
    const clean = (raw || '')
      .replace(/\.[a-zA-Z0-9]+$/, '')
      .replace(/\((?:19|20)\d{2}\)/g, ' ')
      .replace(/\b(?:2160p|1080p|720p|4k|remux|web-dl|hdr|dovi|dv|h265|x265|hevc|aac|ddp\d(?:\.\d)?)\b/gi, ' ')
      .trim();

    const extractedEp = this.extractEpisode(clean);
    const epToUse = targetEpisode !== null ? targetEpisode : extractedEp;

    // 匹配季集标记，例如: "Camp Snoopy S01E01 ..." 或 "豆豆农场 - S01E01 - ..."
    const seMatch = clean.match(/^(.*?)(?:\s+|-|_)*\b(S\d+)?\s*(E\d+|第\s*\d+\s*集|EP\d+)\b/i);
    if (seMatch) {
      const rawTitle = seMatch[1].replace(/[:：_\-\[\]\(\)]+/g, ' ').trim();
      const epNum = parseInt(seMatch[3].replace(/\D/g, ''), 10);
      return {
        title: rawTitle,
        isSeries: true,
        episode: epToUse !== null ? epToUse : epNum
      };
    }

    // 电影标题：去除年份、分辨率及标签
    const movieTitle = clean
      .replace(/\((?:19|20)\d{2}\).*$/, '')
      .replace(/(?:19|20)\d{2}.*$/, '')
      .replace(/[:：_\-\[\]\(\)]+/g, ' ')
      .trim();

    return {
      title: movieTitle || clean,
      isSeries: epToUse !== null,
      episode: epToUse
    };
  }

  // 严格匹配目标判定（杜绝张冠李戴）
  isTargetMatch(candidateName, targetQuery, targetEpisode = null) {
    if (!candidateName || !targetQuery) return false;
    const parsed = this.parseQuery(targetQuery, targetEpisode);
    const subTitles = (parsed.title || '').split(/[\/／]/).map(s => s.trim()).filter(s => s.length >= 2);
    if (subTitles.length === 0) return false;

    const candNorm = this.normalize(candidateName);

    // 1. 标题校验：候选文件必须包含完整的主标题（或中英文别名之一）
    const titleMatch = subTitles.some(t => {
      const norm = this.normalize(t);
      return norm.length >= 2 && (candNorm.includes(norm) || norm.includes(candNorm));
    });
    if (!titleMatch) return false;

    // 2. 电视剧集集数严格校验：若当前检索的是剧集某一集，候选文件必须且只能匹配该集！
    if (parsed.isSeries && parsed.episode !== null) {
      const candEp = this.extractEpisode(candidateName);
      if (candEp === null || candEp !== parsed.episode) {
        return false;
      }
    }

    return true;
  }

  /**
   * 在指定 115 账号中定位文件，获取该账号下真实的 file_id 与 pickcode
   */
  async resolveFileOnCookie(cookie, pickcode = '', filename = '', sha1 = '', clientUserAgent = '') {
    if (!cookie) return { found: false };

    // 1. 若有 pickcode，优先通过 getUserDirectLink 探测该账号是否直接拥有该文件 (100% 准确提取该账号所属真实 file_id 与直链)
    if (pickcode) {
      const linkRes = await this.getUserDirectLink(cookie, pickcode, '', clientUserAgent);
      if (linkRes.success && linkRes.downloadUrl) {
        // 若传了期望文件名，必须验证文件名匹配，防止 pickcode 解析出无关文件
        if (filename && linkRes.filename && !this.isTargetMatch(linkRes.filename, filename)) {
          console.warn(`[115] resolveFileOnCookie: pickcode 解析的文件名 "${linkRes.filename}" 与请求 "${filename}" 不匹配，放弃该直链命中`);
        } else {
          return {
            found: true,
            fileId: linkRes.fileId,
            pickcode: linkRes.pickcode || pickcode,
            filename: linkRes.filename || filename,
            filesize: linkRes.filesize || 0,
            downloadUrl: linkRes.downloadUrl,
            uid: linkRes.uid
          };
        }
      }

      // 1.2 若直接解析直链未命中，在指定账号网盘中直接搜索该 pickcode
      const pcSearch = await this.searchUserDrive(cookie, pickcode);
      if (pcSearch.found && pcSearch.fileId) {
        if (filename && pcSearch.filename && !this.isTargetMatch(pcSearch.filename, filename)) {
          console.warn(`[115] resolveFileOnCookie: pickcode 搜索到的文件名 "${pcSearch.filename}" 与请求 "${filename}" 不匹配，放弃该命中`);
        } else {
          let resolvedDl = '';
          let resolvedUid = '';
          if (pcSearch.pickcode) {
            const directRes = await this.getUserDirectLink(cookie, pcSearch.pickcode, pcSearch.fileId, clientUserAgent);
            if (directRes.success && directRes.downloadUrl) {
              resolvedDl = directRes.downloadUrl;
              resolvedUid = directRes.uid;
            }
          }
          return {
            ...pcSearch,
            downloadUrl: resolvedDl,
            uid: resolvedUid
          };
        }
      }
    }

    // 2. 若 pickcode 未直接命中，通过有效文件名在指定账号网盘中精确搜索匹配真实 file_id
    if (filename && !filename.includes('redirect_url') && !filename.includes('pickcode=')) {
      const searchRes = await this.searchUserDrive(cookie, filename);
      if (searchRes.found && searchRes.fileId) {
        let resolvedDl = '';
        let resolvedUid = '';
        if (searchRes.pickcode) {
          const directRes = await this.getUserDirectLink(cookie, searchRes.pickcode, searchRes.fileId, clientUserAgent);
          if (directRes.success && directRes.downloadUrl) {
            resolvedDl = directRes.downloadUrl;
            resolvedUid = directRes.uid;
          }
        }
        return {
          found: true,
          fileId: searchRes.fileId,
          pickcode: searchRes.pickcode,
          filename: searchRes.filename || filename,
          filesize: searchRes.filesize || 0,
          sha1: searchRes.sha1 || sha1,
          downloadUrl: resolvedDl,
          uid: resolvedUid
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
