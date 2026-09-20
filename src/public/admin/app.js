// Funland Admin Console Client Logic

let currentTab = 'dashboard';

// 通用管理员接口请求封装 (自动携带 Bearer Token、防 304 缓存机制与 401 拦截)
async function adminFetch(url, options = {}) {
  const token = localStorage.getItem('funland_admin_token') || '';
  const headers = Object.assign({}, options.headers || {});
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  headers['Cache-Control'] = 'no-cache, no-store';
  headers['Pragma'] = 'no-cache';
  options.headers = headers;
  options.cache = 'no-store';

  // 拼接随机时间戳避免任何浏览器与中间代理 GET 缓存
  const separator = url.includes('?') ? '&' : '?';
  const targetUrl = options.method && options.method.toUpperCase() !== 'GET' ? url : `${url}${separator}_t=${Date.now()}`;

  try {
    const res = await fetch(targetUrl, options);
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
    users: ['用户管理与配额', '配置开放自主注册开关、最大注册人数上限并管理用户账号与会员卡'],
    'invite-codes': ['邀请码管理', '配置通用邀请码、生成一次性体验卡/月卡/季卡/年卡并管理已发布的邀请码'],
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
  else if (currentTab === 'invite-codes') loadInviteCodes();
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

      // 大号隔离与游客策略
      if (s.allow_master_direct_fallback !== undefined && document.getElementById('cfgMasterDirectFallback')) {
        document.getElementById('cfgMasterDirectFallback').value = s.allow_master_direct_fallback;
      }
      if (s.allow_master_for_guests !== undefined && document.getElementById('cfgMasterForGuests')) {
        document.getElementById('cfgMasterForGuests').value = s.allow_master_for_guests;
      }

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

async function syncAllEmbyUsers() {
  if (!confirm('确定要从 Emby 服务器全量拉取并同步所有用户到 Funland 吗？\n\n- 自动排除当前选中的模板用户\n- 已存在用户自动补齐关联，不会覆盖现有 115 绑定配置\n- 新导入用户可直接使用其 Emby 现有密码登录 Funland 用户中心')) {
    return;
  }

  try {
    showToast('正在向 Emby 发起全量用户同步，请稍候...', 'info');
    const res = await adminFetch('/api/admin/sync-emby-users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.msg || 'Emby 用户全量同步成功！');
      fetchEmbyUsersList();
      if (typeof loadUsers === 'function') loadUsers();
      if (typeof loadStats === 'function') loadStats();
      alert(`🎉 Emby 用户同步完成！\n\n- Emby 检测总数: ${json.summary.total} 人\n- 成功新增导入: ${json.summary.createdCount} 人\n- 自动补齐关联: ${json.summary.updatedCount} 人\n- 排除模板用户: ${json.summary.skippedTemplate ? json.summary.skippedTemplate : '无'}\n\n所有新导入用户现已可在 Funland 用户中心直接使用其 Emby 原密码登录并绑定 115！`);
    } else {
      showToast(json.error || '同步失败', 'error');
      alert(`⚠️ 同步失败: ${json.error || '未知错误'}`);
    }
  } catch (err) {
    showToast('同步请求失败: ' + err.message, 'error');
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
    cache_ttl_seconds: document.getElementById('cfgTtl').value.trim(),
    allow_master_direct_fallback: document.getElementById('cfgMasterDirectFallback') ? document.getElementById('cfgMasterDirectFallback').value : 'false',
    allow_master_for_guests: document.getElementById('cfgMasterForGuests') ? document.getElementById('cfgMasterForGuests').value : 'false'
  };

  try {
    const res = await adminFetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings })
    });
    const json = await res.json();
    if (json.success) {
      showToast('Emby 与大号安全隔离配置已保存！正在刷新用户列表...');
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

// 扫码添加源网盘弹窗逻辑
let adminQrPollTimer = null;
let currentAdminQrSession = null;

async function openAdminQrModal() {
  const modal = document.getElementById('adminQrModal');
  if (modal) modal.style.display = 'flex';
  refreshAdminQr();
}

function closeAdminQrModal() {
  const modal = document.getElementById('adminQrModal');
  if (modal) modal.style.display = 'none';
  if (adminQrPollTimer) {
    clearInterval(adminQrPollTimer);
    adminQrPollTimer = null;
  }
}

async function refreshAdminQr() {
  if (adminQrPollTimer) {
    clearInterval(adminQrPollTimer);
    adminQrPollTimer = null;
  }
  const img = document.getElementById('adminQrImg');
  const statusEl = document.getElementById('adminQrStatus');
  if (statusEl) statusEl.innerText = '⏳ 正在向 115 申请扫码凭证...';

  try {
    const res = await adminFetch('/api/admin/cookie-pool/qr-session', { method: 'POST' });
    const json = await res.json();
    if (json.success && json.qrDataUrl) {
      currentAdminQrSession = json;
      if (img) img.src = json.qrDataUrl;
      if (statusEl) statusEl.innerText = '📱 请使用手机端 115 App 扫码确认';
      startAdminQrPolling(json.uid, json.time, json.sign);
    } else {
      if (statusEl) statusEl.innerText = '❌ 二维码生成失败: ' + (json.error || '未知错误');
    }
  } catch (e) {
    if (statusEl) statusEl.innerText = '❌ 网络请求异常: ' + e.message;
  }
}

function startAdminQrPolling(uid, time, sign) {
  if (adminQrPollTimer) clearInterval(adminQrPollTimer);
  adminQrPollTimer = setInterval(async () => {
    try {
      const res = await adminFetch(`/api/admin/cookie-pool/qr-status?uid=${uid}&time=${time}&sign=${sign}`);
      const json = await res.json();
      const statusEl = document.getElementById('adminQrStatus');

      if (json.saved) {
        clearInterval(adminQrPollTimer);
        adminQrPollTimer = null;
        if (statusEl) statusEl.innerText = `🎉 登录成功！已录入账号: ${json.username || ''} (${json.vipInfo || ''})`;
        showToast(`🎉 源网盘扫码成功！账号: ${json.username || ''} 已加入资源池`);
        setTimeout(() => {
          closeAdminQrModal();
          loadCookiePool();
        }, 1500);
      } else if (json.status === 'scanned') {
        if (statusEl) statusEl.innerText = '📱 已扫码，请在手机端点击【确认登录】';
      } else if (json.status === 'expired') {
        clearInterval(adminQrPollTimer);
        adminQrPollTimer = null;
        if (statusEl) statusEl.innerText = '⚠️ 二维码已失效，请点击刷新';
      }
    } catch (e) {}
  }, 2000);
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
      adminFetch('/api/admin/users?t=' + Date.now()),
      adminFetch('/api/admin/settings?t=' + Date.now())
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
      tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 20px;">暂无注册用户</td></tr>';
      return;
    }

    const typeLabels = { trial_7d: '7天体验', monthly: '月卡', quarterly: '季卡', yearly: '年卡' };

    usersJson.data.forEach(user => {
      const tr = document.createElement('tr');
      const isDisabled = user.cookie_status === 'disabled';
      const hasEmby = Boolean(user.emby_user_id);
      const mType = user.membership_type || '';
      const mExp = user.membership_expires_at || '';
      const isExpired = mExp && new Date() > new Date(mExp);
      const mLabel = typeLabels[mType] || (mType === 'permanent' ? '永久' : (mType ? mType : '未设置'));
      const mBadgeClass = !mType ? 'badge-fallback' : (isExpired ? 'badge-fallback' : 'badge-step1');
      const expDisplay = !mExp ? (mType ? '永久' : '—') : (isExpired
        ? `<span style="color:#f87171;">${new Date(mExp).toLocaleDateString()} 已过期</span>`
        : new Date(mExp).toLocaleDateString());

      tr.innerHTML = `
        <td>#${user.id}</td>
        <td><strong>${escapeHtml(user.username)}</strong></td>
        <td>${hasEmby ? `<span class="badge badge-step2" title="Emby ID: ${escapeHtml(user.emby_user_id)}">✅ 已关联</span>` : `<span class="badge badge-fallback">未关联</span>`}</td>
        <td><span class="badge ${user.cookie_status === 'active' ? 'badge-step1' : 'badge-fallback'}">${escapeHtml(user.cookie_status || '未绑定')}</span></td>
        <td><span class="badge ${mBadgeClass}">${escapeHtml(mLabel)}</span></td>
        <td style="font-size:0.8rem;">${expDisplay}</td>
        <td>${user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}</td>
        <td><span class="badge ${isDisabled ? 'badge-fallback' : 'badge-step2'}">${isDisabled ? '已封禁' : '正常'}</span></td>
        <td style="display: flex; gap: 6px; flex-wrap: wrap;">
          ${!hasEmby ? `<button class="btn btn-primary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="syncUserToEmby(${user.id}, '${escapeHtml(user.username)}')">同步至 Emby</button>` : ''}
          <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="setUserMembership(${user.id}, '${escapeHtml(user.username)}')"><i class="ri-vip-crown-line"></i> 会员</button>
          <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 0.75rem;" onclick="toggleUser(${user.id})">${isDisabled ? '解封' : '封禁'}</button>
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.75rem;" onclick="deleteUserAccount(${user.id})">删除</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    showToast('加载用户数据失败: ' + e.message, 'error');
  }
}

async function syncUserToEmby(id, username) {
  try {
    showToast(`正在向 Emby 同步创建用户 "${username}" 并配置密码...`);
    const res = await adminFetch(`/api/admin/users/${id}/sync-emby`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
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
  if (!confirm('确定彻底删除该用户？（将同步从 Emby 服务端彻底注销该用户）')) return;
  try {
    const res = await adminFetch(`/api/admin/users/${id}?deleteEmby=true`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      showToast(json.msg || '用户及 Emby 账号已成功删除');
      loadUsers();
    } else {
      showToast(json.error || '删除失败', 'error');
    }
  } catch (e) {
    showToast('删除请求异常: ' + e.message, 'error');
  }
}

// 设置用户会员
function setUserMembership(id, username) {
  const type = prompt(
    `请选择会员卡类型（输入数字）：\n1. 7天体验卡\n2. 月卡 (30天)\n3. 季卡 (90天)\n4. 年卡 (365天)\n5. 永久会员\n\n用户: ${username}`
  );
  if (!type) return;
  const typeMap = { '1': 'trial_7d', '2': 'monthly', '3': 'quarterly', '4': 'yearly', '5': 'permanent' };
  const membershipType = typeMap[type.trim()];
  if (!membershipType) { showToast('输入无效，请输入1~5', 'error'); return; }
  adminFetch(`/api/admin/users/${id}/membership`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ membershipType })
  }).then(r => r.json()).then(json => {
    if (json.success) { showToast(json.msg); loadUsers(); }
    else showToast(json.error || '设置失败', 'error');
  }).catch(e => showToast(e.message, 'error'));
}

// 邀请码管理
async function loadInviteCodes() {
  try {
    const [codesRes, settingsRes] = await Promise.all([
      adminFetch('/api/admin/invite-codes?t=' + Date.now()),
      adminFetch('/api/admin/settings?t=' + Date.now())
    ]);
    if (settingsRes.ok) {
      const sj = await settingsRes.json();
      if (sj.success) {
        const uCode = document.getElementById('cfgUniversalCode');
        const invReq = document.getElementById('cfgInviteRequired');
        if (uCode) uCode.value = sj.data.universal_invite_code || '';
        if (invReq) invReq.value = sj.data.invite_code_required || 'true';
      }
    }
    if (!codesRes.ok) return;
    const json = await codesRes.json();
    const tbody = document.getElementById('inviteCodesTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!json.data || json.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--text-muted); padding:20px;">暂无邀请码</td></tr>';
      return;
    }
    const typeLabels = { trial_7d: '7天体验', monthly: '月卡', quarterly: '季卡', yearly: '年卡' };
    const statusMap = { unused: '未使用', used: '已使用', revoked: '已吊销' };
    const statusColors = { unused: 'badge-step1', used: 'badge-step2', revoked: 'badge-fallback' };
    json.data.forEach(code => {
      const isExpiredCode = code.expires_at && new Date() > new Date(code.expires_at);
      const statusLabel = (isExpiredCode && code.status === 'unused') ? '已过期' : (statusMap[code.status] || code.status);
      const statusColor = (isExpiredCode && code.status === 'unused') ? 'badge-fallback' : (statusColors[code.status] || 'badge-fallback');
      const tr = document.createElement('tr');
      const codeStr = escapeHtml(code.code);
      tr.innerHTML = `
        <td>#${code.id}</td>
        <td><code style="font-size:0.9rem;letter-spacing:0.05em;color:#a78bfa;cursor:pointer;" onclick="navigator.clipboard.writeText('${codeStr}').then(()=>showToast('已复制'))">${codeStr}</code></td>
        <td><span class="badge badge-step2">${typeLabels[code.type] || code.type}</span></td>
        <td><span class="badge ${statusColor}">${statusLabel}</span></td>
        <td>${code.used_by_user_id ? '#' + code.used_by_user_id : '—'}</td>
        <td style="font-size:0.8rem;">${code.created_at ? new Date(code.created_at).toLocaleDateString() : '—'}</td>
        <td style="font-size:0.8rem;">${code.used_at ? new Date(code.used_at).toLocaleDateString() : '—'}</td>
        <td><button class="btn btn-danger" style="padding:4px 8px;font-size:0.75rem;" onclick="deleteInviteCode(${code.id})">删除</button></td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    showToast('加载邀请码失败: ' + e.message, 'error');
  }
}

async function generateInviteCodes() {
  const type = document.getElementById('genCodeType').value;
  const count = parseInt(document.getElementById('genCodeCount').value, 10) || 1;
  const expiresInDays = parseInt(document.getElementById('genCodeExpiry').value, 10) || 0;
  try {
    const res = await adminFetch('/api/admin/invite-codes/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, count, expiresInDays })
    });
    const json = await res.json();
    if (json.success) {
      showToast(json.msg);
      const resultDiv = document.getElementById('generatedCodesResult');
      const titleEl = document.getElementById('generatedCodesTitle');
      const listEl = document.getElementById('generatedCodesList');
      if (resultDiv && titleEl && listEl) {
        titleEl.textContent = json.msg;
        listEl.innerHTML = json.data.map(c =>
          `<span onclick="navigator.clipboard.writeText('${c}').then(()=>showToast('已复制 ${c}'))" style="background:rgba(167,139,250,0.15);border:1px solid rgba(167,139,250,0.3);border-radius:6px;padding:6px 12px;font-family:monospace;font-size:0.9rem;cursor:pointer;color:#a78bfa;letter-spacing:0.05em;">${c}</span>`
        ).join('');
        resultDiv.style.display = 'block';
      }
      loadInviteCodes();
    } else {
      showToast(json.error || '生成失败', 'error');
    }
  } catch (e) {
    showToast('生成异常: ' + e.message, 'error');
  }
}

async function deleteInviteCode(id) {
  if (!confirm('确定删除该邀请码？')) return;
  try {
    const res = await adminFetch(`/api/admin/invite-codes/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) { showToast(json.msg); loadInviteCodes(); }
    else showToast(json.error || '删除失败', 'error');
  } catch (e) { showToast(e.message, 'error'); }
}

async function saveUniversalCode() {
  const code = (document.getElementById('cfgUniversalCode') ? document.getElementById('cfgUniversalCode').value : '').trim().toUpperCase();
  try {
    const res = await adminFetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { universal_invite_code: code } })
    });
    const json = await res.json();
    if (json.success) showToast(code ? `通用邀请码已设为: ${code}` : '通用邀请码已禁用');
    else showToast(json.error || '保存失败', 'error');
  } catch (e) { showToast(e.message, 'error'); }
}

async function saveInviteSettings() {
  const invite_code_required = document.getElementById('cfgInviteRequired') ? document.getElementById('cfgInviteRequired').value : 'true';
  try {
    const res = await adminFetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { invite_code_required } })
    });
    const json = await res.json();
    if (json.success) showToast('邀请码设置已保存！');
    else showToast(json.error || '保存失败', 'error');
  } catch (e) { showToast(e.message, 'error'); }
}

function copyAllCodes() {
  const codes = Array.from(document.querySelectorAll('#generatedCodesList span')).map(el => el.textContent).join('\n');
  navigator.clipboard.writeText(codes).then(() => showToast('已全部复制到剪贴板'));
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
window.syncUserToEmby = syncUserToEmby;
window.syncAllEmbyUsers = syncAllEmbyUsers;
window.setUserMembership = setUserMembership;
window.loadUsers = loadUsers;
window.loadInviteCodes = loadInviteCodes;
window.generateInviteCodes = generateInviteCodes;
window.deleteInviteCode = deleteInviteCode;
window.saveUniversalCode = saveUniversalCode;
window.saveInviteSettings = saveInviteSettings;
window.copyAllCodes = copyAllCodes;

// 启动入口
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkAuthAndInit);
} else {
  checkAuthAndInit();
}
