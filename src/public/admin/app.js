// Funland Admin Console Client Logic

let currentTab = 'dashboard';

// 通用管理员接口请求封装 (自动携带 Bearer Token 与 401 拦截)
async function adminFetch(url, options = {}) {
  const token = localStorage.getItem('funland_admin_token') || '';
  const headers = Object.assign({}, options.headers || {});
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  options.headers = headers;

  try {
    const res = await fetch(url, options);
    if (res.status === 401) {
      localStorage.removeItem('funland_admin_token');
      showLoginOverlay('管理员认证已过期或未授权，请重新登录');
    }
    return res;
  } catch (err) {
    console.error('adminFetch error:', err);
    throw err;
  }
}

// 显示与隐藏登录弹窗
function showLoginOverlay(errMsg = '') {
  const overlay = document.getElementById('adminLoginOverlay');
  if (overlay) {
    overlay.style.display = 'flex';
    overlay.classList.remove('hidden');
  }
  const alertBox = document.getElementById('loginErrorAlert');
  if (alertBox) {
    if (errMsg) {
      alertBox.innerText = errMsg;
      alertBox.style.display = 'block';
    } else {
      alertBox.style.display = 'none';
    }
  }
  const badge = document.getElementById('currentAdminBadge');
  if (badge) badge.innerText = '未登录';
  const dot = document.querySelector('.status-dot-pulse');
  if (dot) dot.classList.add('offline');
}

function hideLoginOverlay() {
  const overlay = document.getElementById('adminLoginOverlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.add('hidden');
  }
  const alertBox = document.getElementById('loginErrorAlert');
  if (alertBox) alertBox.style.display = 'none';
}

// 检查身份状态并初始化
async function checkAuthAndInit() {
  setupTabs();

  const token = localStorage.getItem('funland_admin_token');
  if (!token) {
    showLoginOverlay();
    return;
  }

  try {
    const res = await fetch('/api/admin/auth-status', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const json = await res.json();
    if (json.success && json.authenticated) {
      hideLoginOverlay();
      const badge = document.getElementById('currentAdminBadge');
      if (badge) badge.innerText = json.username || 'admin';
      const dot = document.querySelector('.status-dot-pulse');
      if (dot) dot.classList.remove('offline');
      refreshCurrentTab();
    } else {
      localStorage.removeItem('funland_admin_token');
      showLoginOverlay('管理员登录已过期，请重新验证身份');
    }
  } catch (e) {
    console.error('Auth verification failed:', e);
    showLoginOverlay();
  }
}

// 管理员登录处理
async function handleAdminLogin(e) {
  if (e && e.preventDefault) e.preventDefault();
  const user = document.getElementById('adminUser').value.trim();
  const pass = document.getElementById('adminPass').value.trim();
  const alertBox = document.getElementById('loginErrorAlert');
  const btn = document.getElementById('btnAdminLogin');

  if (!user || !pass) {
    if (alertBox) {
      alertBox.innerText = '请输入管理员账号与密码';
      alertBox.style.display = 'block';
    }
    return;
  }

  try {
    if (btn) {
      btn.disabled = true;
      btn.innerText = '正在验证身份...';
    }
    if (alertBox) alertBox.style.display = 'none';

    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });
    const json = await res.json();

    if (json.success && json.token) {
      localStorage.setItem('funland_admin_token', json.token);
      hideLoginOverlay();
      const badge = document.getElementById('currentAdminBadge');
      if (badge) badge.innerText = json.username || user;
      const dot = document.querySelector('.status-dot-pulse');
      if (dot) dot.classList.remove('offline');
      showToast('登录成功，欢迎使用 Funland 管理控制台！');
      refreshCurrentTab();
    } else {
      if (alertBox) {
        alertBox.innerText = json.error || '管理员账号或密码错误';
        alertBox.style.display = 'block';
      }
    }
  } catch (err) {
    if (alertBox) {
      alertBox.innerText = '网络连接异常: ' + err.message;
      alertBox.style.display = 'block';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '⚡ 验证身份并进入';
    }
  }
}

// 管理员登出
function handleAdminLogout() {
  localStorage.removeItem('funland_admin_token');
  const pass = document.getElementById('adminPass');
  if (pass) pass.value = '';
  showLoginOverlay('已安全退出后台');
  showToast('已安全退出管理后台');
}

// 侧边栏选项卡切换
function setupTabs() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const tab = item.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tab) {
  if (!tab) return;
  currentTab = tab;

  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));

  const navItem = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  const section = document.getElementById(`tab-${tab}`);
  if (navItem) navItem.classList.add('active');
  if (section) section.classList.add('active');

  const titles = {
    dashboard: ['系统总览', 'Funland 实时运行指标、Emby 拦截率及云端直链调度状态'],
    emby: ['Emby 服务设置', '配置上游 Emby 原始服务器地址及媒体流 302 拦截策略'],
    'cookie-pool': ['115 账号资源池', '管理系统兜底源盘与秒传使用的 115 高级账号'],
    cache: ['滑动过期缓存', '查看当前 30 分钟活动直链，验证滑动续期与命中情况'],
    files: ['文件与 SHA1 库', '本地已索引的媒体文件、SHA1 指纹与播放热度'],
    users: ['用户管理与配额', '配置开放自主注册开关、最大注册人数上限并管理用户账号'],
    logs: ['播放拦截日志', '查看实时捕获的 Emby 播放请求流与 302 调度链路']
  };

  if (titles[tab]) {
    const titleEl = document.getElementById('tabTitle');
    const descEl = document.getElementById('tabDesc');
    if (titleEl) titleEl.innerText = titles[tab][0];
    if (descEl) descEl.innerText = titles[tab][1];
  }

  refreshCurrentTab();
}

function refreshCurrentTab() {
  const token = localStorage.getItem('funland_admin_token');
  if (!token) {
    showLoginOverlay();
    return;
  }

  if (currentTab === 'dashboard') loadStats();
  else if (currentTab === 'emby') loadEmbySettings();
  else if (currentTab === 'cookie-pool') loadCookiePool();
  else if (currentTab === 'cache') loadCache();
  else if (currentTab === 'files') loadFiles();
  else if (currentTab === 'users') loadUsers();
  else if (currentTab === 'logs') loadLogs();
}

// 统计接口
async function loadStats() {
  try {
    const res = await adminFetch('/api/admin/stats');
    if (!res.ok) return;
    const json = await res.json();
    if (json.success) {
      const d = json.data;
      const elToday = document.getElementById('statTodayPlays');
      const elTotal = document.getElementById('statTotalPlays');
      const elHitRate = document.getElementById('statHitRate');
      const elActiveKeys = document.getElementById('statActiveKeys');
      const elPool = document.getElementById('statPoolCount');
      if (elToday) elToday.innerText = d.todayPlays || 0;
      if (elTotal) elTotal.innerText = d.totalPlays || 0;
      if (elHitRate) elHitRate.innerText = d.cache ? d.cache.hitRate : '100%';
      if (elActiveKeys) elActiveKeys.innerText = d.cache ? d.cache.activeKeysCount : 0;
      if (elPool) elPool.innerText = d.totalPool || 0;

      const currentHost = window.location.hostname || 'localhost';
      const topDomain = document.getElementById('topDomain');
      if (topDomain) topDomain.innerText = currentHost;

      // 智能动态生成拓扑地址 (自适应反向代理及标准端口)
      const isHttps = window.location.protocol === 'https:';
      const proto = isHttps ? 'https:' : 'http:';
      const port = window.location.port;
      const isCustomPort = Boolean(port && port !== '80' && port !== '443');

      // 1. 用户中心地址
      const portalBase = isCustomPort ? `${proto}//${currentHost}:${port}` : `${proto}//${currentHost}`;
      if (document.getElementById('topologyPortal')) {
        document.getElementById('topologyPortal').innerText = `${portalBase}/`;
      }

      // 2. 管理后台地址
      const adminBase = isCustomPort && port === '8091'
        ? `${proto}//${currentHost}:8091/`
        : `${portalBase}/admin/`;
      if (document.getElementById('topologyAdmin')) {
        document.getElementById('topologyAdmin').innerText = adminBase;
      }

      // 3. Emby 播放代理地址
      let embyUrl;
      if (isHttps && !isCustomPort) {
        const baseRoot = currentHost.replace(/^(admin|portal)\./, '');
        embyUrl = `https://emby.${baseRoot} (或 http://${currentHost}:8097)`;
      } else {
        embyUrl = `http://${currentHost}:${d.ports ? d.ports.emby : 8097}`;
      }
      if (document.getElementById('topologyEmby')) {
        document.getElementById('topologyEmby').innerText = embyUrl;
      }
    }
  } catch (e) {
    console.error('loadStats failed:', e);
  }
}

// Emby 设置
let cachedEmbyTemplateUserId = '';

async function loadEmbySettings() {
  try {
    const res = await adminFetch('/api/admin/settings');
    if (!res.ok) return;
    const json = await res.json();
    if (json.success) {
      const s = json.data;
      if (s.emby_upstream_url && document.getElementById('cfgEmbyUrl')) document.getElementById('cfgEmbyUrl').value = s.emby_upstream_url;
      if (s.emby_api_key && document.getElementById('cfgEmbyKey')) document.getElementById('cfgEmbyKey').value = s.emby_api_key;
      if (s.acceleration_mode && document.getElementById('cfgAccelMode')) document.getElementById('cfgAccelMode').value = s.acceleration_mode;
      if (s.cache_ttl_seconds && document.getElementById('cfgTtl')) document.getElementById('cfgTtl').value = s.cache_ttl_seconds;

      // 联动 Emby 同步配置
      if (s.emby_sync_user !== undefined && document.getElementById('cfgEmbySyncUser')) {
        document.getElementById('cfgEmbySyncUser').value = s.emby_sync_user;
      }
      cachedEmbyTemplateUserId = s.emby_template_user_id || '';
      fetchEmbyUsersList(cachedEmbyTemplateUserId);
    }
  } catch (e) { }
}

async function fetchEmbyUsersList(selectedUserId = '') {
  const select = document.getElementById('cfgEmbyTemplateUser');
  if (!select) return;

  const targetId = selectedUserId || cachedEmbyTemplateUserId;

  try {
    const res = await adminFetch('/api/admin/emby-users');
    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      select.innerHTML = '<option value="">-- 未选择模板 (使用 Emby 默认配置) --</option>';
      json.data.forEach(u => {
        const opt = document.createElement('option');
        opt.value = u.id;
        opt.textContent = `${u.name} ${u.isAdmin ? '👑 [管理员]' : '👤 [普通用户]'}`;
        if (u.id === targetId) opt.selected = true;
        select.appendChild(opt);
      });
    } else {
      console.warn('获取 Emby 用户列表警告:', json.error);
    }
  } catch (err) {
    console.error('拉取 Emby 用户失败:', err);
  }
}

async function saveEmbySyncSettings(e) {
  if (e && e.preventDefault) e.preventDefault();
  const syncUser = document.getElementById('cfgEmbySyncUser').value;
  const select = document.getElementById('cfgEmbyTemplateUser');
  const templateUserId = select ? select.value : '';
  const templateUserName = (select && select.selectedOptions && select.selectedOptions[0]) 
    ? select.selectedOptions[0].textContent 
    : '';

  try {
    const res = await adminFetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          emby_sync_user: syncUser,
          emby_template_user_id: templateUserId,
          emby_template_user_name: templateUserName
        }
      })
    });
    const json = await res.json();
    if (json.success) {
      cachedEmbyTemplateUserId = templateUserId;
      showToast('联动 Emby 用户同步与模板配置已保存生效！');
    } else {
      showToast(json.error || '保存失败', 'error');
    }
  } catch (err) {
    showToast('网络异常: ' + err.message, 'error');
  }
}

async function saveEmbySettings(e) {
  if (e && e.preventDefault) e.preventDefault();
  const settings = {
    emby_upstream_url: document.getElementById('cfgEmbyUrl').value.trim(),
    emby_api_key: document.getElementById('cfgEmbyKey').value.trim(),
    acceleration_mode: document.getElementById('cfgAccelMode').value,
    cache_ttl_seconds: document.getElementById('cfgTtl').value.trim()
  };

  try {
    const res = await adminFetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings })
    });
    const json = await res.json();
    if (json.success) {
      showToast('Emby 基础连接配置已保存！正在刷新用户列表...');
      fetchEmbyUsersList();
    } else {
      showToast(json.error || '保存失败', 'error');
    }
  } catch (err) {
    showToast('请求异常: ' + err.message, 'error');
  }
}

// Cookie 池
async function loadCookiePool() {
  try {
    const res = await adminFetch('/api/admin/cookie-pool');
    if (!res.ok) return;
    const json = await res.json();
    const tbody = document.getElementById('poolTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!json.data || json.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">暂无资源池账号，请在上方添加 115 Cookie</td></tr>';
      return;
    }

    json.data.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>#${item.id}</td>
        <td><strong>${escapeHtml(item.name)}</strong></td>
        <td><span class="badge badge-step1">${escapeHtml(item.vip_expire || '普通')}</span></td>
        <td><code>${escapeHtml(item.cookiePreview)}</code></td>
        <td><span class="badge badge-step2">${escapeHtml(item.status)}</span></td>
        <td>
          <button class="btn btn-danger" style="padding: 4px 10px; font-size: 0.75rem;" onclick="deleteCookie(${item.id})">删除</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    showToast('加载 Cookie 池失败', 'error');
  }
}

async function addCookieToPool(e) {
  if (e && e.preventDefault) e.preventDefault();
  const name = document.getElementById('poolName').value.trim();
  const cookie = document.getElementById('poolCookie').value.trim();

  showToast('正在验证 115 账号有效性...');
  try {
    const res = await adminFetch('/api/admin/cookie-pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, cookie })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.msg || '添加成功！');
      document.getElementById('addPoolForm').reset();
      loadCookiePool();
    } else {
      showToast(json.error || '添加失败', 'error');
    }
  } catch (err) {
    showToast('提交失败: ' + err.message, 'error');
  }
}

async function deleteCookie(id) {
  if (!confirm('确定从资源池移除该账号？')) return;
  try {
    const res = await adminFetch(`/api/admin/cookie-pool/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      showToast('已删除');
      loadCookiePool();
    }
  } catch (e) { }
}

// 缓存列表
async function loadCache() {
  try {
    const res = await adminFetch('/api/admin/cache');
    if (!res.ok) return;
    const json = await res.json();
    const tbody = document.getElementById('cacheTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const items = json.data && json.data.items ? json.data.items : [];
    if (items.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px;">当前无活动直链缓存（播放后将自动显示）</td></tr>';
      return;
    }

    items.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><code>${escapeHtml(item.key)}</code></td>
        <td><strong style="color: #34d399;">${item.remainingSeconds}s</strong> (滑动续期)</td>
        <td>${new Date(item.setAt).toLocaleTimeString()}</td>
        <td style="font-size: 0.78rem; color: var(--text-muted);">${escapeHtml(item.valuePreview)}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { }
}

async function flushCache() {
  if (!confirm('确定清空所有直链缓存？清空后下一个播放请求将重新解析')) return;
  try {
    const res = await adminFetch('/api/admin/cache/flush', { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      showToast('缓存已清空');
      loadCache();
    }
  } catch (e) { }
}

// 文件指纹库
async function loadFiles() {
  try {
    const res = await adminFetch('/api/admin/files');
    if (!res.ok) return;
    const json = await res.json();
    const tbody = document.getElementById('filesTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!json.data || json.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">暂无媒体 SHA1 索引记录（播放或扫描后自动入库）</td></tr>';
      return;
    }

    json.data.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(item.filename)}</strong></td>
        <td><code>${escapeHtml(item.sha1)}</code></td>
        <td>${formatBytes(item.filesize)}</td>
        <td><span class="badge badge-step2">${item.play_count || 0} 次</span></td>
        <td>${item.last_played_at ? new Date(item.last_played_at).toLocaleString() : '未播放'}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { }
}

// 播放日志
async function loadLogs() {
  try {
    const res = await adminFetch('/api/admin/logs');
    if (!res.ok) return;
    const json = await res.json();
    const tbody = document.getElementById('logsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!json.data || json.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">暂无播放日志</td></tr>';
      return;
    }

    json.data.forEach(log => {
      let badgeClass = 'badge-fallback';
      if (log.speed_mode === 'STEP1_OWN') badgeClass = 'badge-step1';
      else if (log.speed_mode === 'STEP2_PEER') badgeClass = 'badge-step2';
      else if (log.speed_mode === 'STEP3_SOURCE') badgeClass = 'badge-step3';
      else if (log.speed_mode === 'CACHE_HIT') badgeClass = 'badge-cache';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(log.created_at).toLocaleTimeString()}</td>
        <td><strong>${escapeHtml(log.item_name || log.item_id)}</strong></td>
        <td>${escapeHtml(log.user_id || 'anonymous')}</td>
        <td><code>${escapeHtml(log.user_ip)}</code></td>
        <td><span class="badge ${badgeClass}">${escapeHtml(log.speed_mode)}</span></td>
        <td style="font-size: 0.78rem; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${escapeHtml(log.redirect_url)}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { }
}

// 用户管理与注册配额
async function loadUsers() {
  try {
    const [usersRes, settingsRes] = await Promise.all([
      adminFetch('/api/admin/users'),
      adminFetch('/api/admin/settings')
    ]);
    if (!usersRes.ok || !settingsRes.ok) return;

    const usersJson = await usersRes.json();
    const settingsJson = await settingsRes.json();

    if (settingsJson.success) {
      const s = settingsJson.data;
      if (s.allow_registration !== undefined && document.getElementById('cfgAllowReg')) {
        document.getElementById('cfgAllowReg').value = s.allow_registration;
      }
      if (s.max_users_limit !== undefined && document.getElementById('cfgMaxUsers')) {
        document.getElementById('cfgMaxUsers').value = s.max_users_limit;
      }

      const currentCount = usersJson.data ? usersJson.data.length : 0;
      const maxLimit = parseInt(s.max_users_limit || '200', 10);
      const percent = Math.min(100, Math.round((currentCount / maxLimit) * 100));

      const quotaText = document.getElementById('userQuotaText');
      if (quotaText) quotaText.innerText = `${currentCount} / ${maxLimit} (${percent}%)`;
      const bar = document.getElementById('userQuotaBar');
      if (bar) {
        bar.style.width = `${percent}%`;
        if (percent >= 100) {
          bar.style.background = 'linear-gradient(90deg, #ef4444, #f97316)';
        } else {
          bar.style.background = 'linear-gradient(90deg, #6366f1, #a855f7)';
        }
      }
    }

    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!usersJson.data || usersJson.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">暂无注册用户</td></tr>';
      return;
    }

    usersJson.data.forEach(user => {
      const tr = document.createElement('tr');
      const isDisabled = user.cookie_status === 'disabled';
      const hasEmby = Boolean(user.emby_user_id);

      tr.innerHTML = `
        <td>#${user.id}</td>
        <td><strong>${escapeHtml(user.username)}</strong></td>
        <td>${hasEmby ? `<span class="badge badge-step2" title="Emby ID: ${escapeHtml(user.emby_user_id)}">✅ 已关联</span>` : `<span class="badge badge-fallback" title="该用户尚未在 Emby 服务端创建">⚠️ 未同步</span>`}</td>
        <td><span class="badge ${user.cookie_status === 'active' ? 'badge-step1' : 'badge-fallback'}">${escapeHtml(user.cookie_status || '未绑定')}</span></td>
        <td>${user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}</td>
        <td><span class="badge ${isDisabled ? 'badge-fallback' : 'badge-step2'}">${isDisabled ? '已封禁' : '正常'}</span></td>
        <td style="display: flex; gap: 8px; flex-wrap: wrap;">
          ${!hasEmby ? `<button class="btn btn-primary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="syncUserToEmby(${user.id}, '${escapeHtml(user.username)}')">同步至 Emby</button>` : ''}
          <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="toggleUser(${user.id})">
            ${isDisabled ? '解封' : '封禁'}
          </button>
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.75rem;" onclick="deleteUserAccount(${user.id})">
            删除
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    showToast('加载用户数据失败: ' + e.message, 'error');
  }
}

async function syncUserToEmby(id, username) {
  const pwd = prompt(`请输入要在 Emby 中为用户 "${username}" 创建的初始密码\n(若留空则默认为 12345678):`, '12345678');
  if (pwd === null) return;
  const initialPassword = pwd.trim() || '12345678';

  try {
    showToast(`正在向 Emby 同步创建用户 ${username}...`);
    const res = await adminFetch(`/api/admin/users/${id}/sync-emby`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ initialPassword })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.msg || '同步成功！');
      loadUsers();
    } else {
      showToast(json.error || '同步失败', 'error');
    }
  } catch (err) {
    showToast('同步异常: ' + err.message, 'error');
  }
}

async function saveRegSettings(e) {
  if (e && e.preventDefault) e.preventDefault();
  const allow_registration = document.getElementById('cfgAllowReg').value;
  const max_users_limit = document.getElementById('cfgMaxUsers').value.trim();

  try {
    const res = await adminFetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settings: {
          allow_registration,
          max_users_limit
        }
      })
    });
    const json = await res.json();
    if (json.success) {
      showToast('注册与配额策略已更新！');
      loadUsers();
    } else {
      showToast(json.error || '保存失败', 'error');
    }
  } catch (err) {
    showToast('网络异常: ' + err.message, 'error');
  }
}

async function toggleUser(id) {
  try {
    const res = await adminFetch(`/api/admin/users/${id}/toggle`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      showToast(json.msg || '状态已更改');
      loadUsers();
    }
  } catch (e) { }
}

async function deleteUserAccount(id) {
  if (!confirm('确定彻底删除该用户账号？')) return;
  try {
    const res = await adminFetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      showToast('用户已删除');
      loadUsers();
    }
  } catch (e) { }
}

// 工具函数
function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<span>${type === 'error' ? '❌' : '⚡'}</span><span>${escapeHtml(msg)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 导出全局函数供内联 HTML 事件调用
window.switchTab = switchTab;
window.refreshCurrentTab = refreshCurrentTab;
window.handleAdminLogin = handleAdminLogin;
window.handleAdminLogout = handleAdminLogout;
window.saveEmbySettings = saveEmbySettings;
window.addCookieToPool = addCookieToPool;
window.deleteCookie = deleteCookie;
window.flushCache = flushCache;
window.loadFiles = loadFiles;
window.loadLogs = loadLogs;
window.saveRegSettings = saveRegSettings;
window.toggleUser = toggleUser;
window.deleteUserAccount = deleteUserAccount;

// 启动入口
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkAuthAndInit);
} else {
  checkAuthAndInit();
}
