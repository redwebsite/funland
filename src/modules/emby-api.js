const axios = require('axios');
const https = require('https');
const config = require('../config');
const { dbService } = require('../db/database');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

class EmbyApiService {
  getUpstreamBase() {
    const url = dbService.getSetting('emby_upstream_url', config.emby.upstreamUrl);
    return (url || '').replace(/\/+$/, '');
  }

  getApiKey() {
    return dbService.getSetting('emby_api_key', config.emby.apiKey);
  }

  getHeaders() {
    const token = this.getApiKey();
    const headers = {
      'Content-Type': 'application/json'
    };
    if (token) {
      headers['X-Emby-Token'] = token;
    }
    return headers;
  }

  /**
   * 获取 Emby 上游所有用户列表
   */
  async getEmbyUsers() {
    const base = this.getUpstreamBase();
    if (!base) throw new Error('未配置 Emby 上游服务器地址');

    const res = await axios.get(`${base}/emby/Users`, {
      headers: this.getHeaders(),
      httpsAgent,
      timeout: 6000
    });

    if (Array.isArray(res.data)) {
      return res.data.map(u => ({
        id: u.Id,
        name: u.Name,
        isAdmin: Boolean(u.Policy && u.Policy.IsAdministrator),
        hasPassword: Boolean(u.HasPassword)
      }));
    }
    return [];
  }

  /**
   * 获取指定用户的完整详情（包含 Policy 和 Configuration）
   */
  async getEmbyUser(userId) {
    const base = this.getUpstreamBase();
    if (!base) throw new Error('未配置 Emby 上游服务器地址');

    const res = await axios.get(`${base}/emby/Users/${userId}`, {
      headers: this.getHeaders(),
      httpsAgent,
      timeout: 6000
    });

    return res.data;
  }

  /**
   * 创建 Emby 用户并按模板克隆配置
   * @param {string} username 用户名
   * @param {string} password 密码
   * @param {string} templateUserId 模板用户 ID（可选）
   */
  async createEmbyUser(username, password, templateUserId = '') {
    const base = this.getUpstreamBase();
    if (!base) throw new Error('未配置 Emby 上游服务器地址');
    const headers = this.getHeaders();

    // 1. 创建新用户
    let createRes;
    try {
      createRes = await axios.post(`${base}/emby/Users/New`, {
        Name: username
      }, {
        headers,
        httpsAgent,
        timeout: 6000
      });
    } catch (err) {
      const errMsg = err.response?.data?.message || err.response?.data || err.message;
      if (typeof errMsg === 'string' && (errMsg.includes('already exists') || errMsg.includes('已存在') || err.response?.status === 400)) {
        throw new Error(`Emby 服务端已存在名为 "${username}" 的账号`);
      }
      throw new Error(`创建 Emby 用户失败: ${errMsg}`);
    }

    const newUser = createRes.data;
    const newUserId = newUser.Id;

    // 2. 设置用户密码
    if (password) {
      try {
        await axios.post(`${base}/emby/Users/${newUserId}/Password`, {
          Id: newUserId,
          NewPw: password,
          ResetPassword: false
        }, {
          headers,
          httpsAgent,
          timeout: 6000
        });
      } catch (err) {
        console.warn(`[Emby API] 设置用户 ${username} 密码失败:`, err.message);
      }
    }

    // 3. 克隆模板用户的权限与配置 (联动 Emby 模式)
    if (templateUserId) {
      try {
        const template = await this.getEmbyUser(templateUserId);
        if (template) {
          // 克隆 Policy
          if (template.Policy) {
            const clonedPolicy = Object.assign({}, template.Policy);
            // 确保普通注册用户绝对不是管理员
            clonedPolicy.IsAdministrator = false;
            clonedPolicy.IsDisabled = false;

            await axios.post(`${base}/emby/Users/${newUserId}/Policy`, clonedPolicy, {
              headers,
              httpsAgent,
              timeout: 6000
            });
          }

          // 克隆 Configuration
          if (template.Configuration) {
            await axios.post(`${base}/emby/Users/${newUserId}/Configuration`, template.Configuration, {
              headers,
              httpsAgent,
              timeout: 6000
            });
          }
          console.log(`✅ [Emby API] 成功克隆模板用户 (${template.Name || templateUserId}) 配置至新用户: ${username}`);
        }
      } catch (err) {
        console.warn(`[Emby API] 克隆模板用户配置时遇到警告:`, err.message);
      }
    }

    return {
      success: true,
      embyUserId: newUserId,
      username: newUser.Name
    };
  }

  /**
   * 删除 Emby 用户
   */
  async deleteEmbyUser(userId) {
    const base = this.getUpstreamBase();
    if (!base || !userId) return;

    try {
      await axios.delete(`${base}/emby/Users/${userId}`, {
        headers: this.getHeaders(),
        httpsAgent,
        timeout: 6000
      });
      return true;
    } catch (e) {
      console.warn(`[Emby API] 删除 Emby 用户 ${userId} 失败:`, e.message);
      return false;
    }
  }
}

module.exports = new EmbyApiService();
