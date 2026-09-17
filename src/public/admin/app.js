// Funland Admin Console Client Logic

let currentTab = 'dashboard';

// 初始化
function init() {
  setupTabs();
  loadStats();
  loadEmbySettings();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// 选项卡切换
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
    document.getElementById('tabTitle').innerText = titles[tab][0];
    document.getElementById('tabDesc').innerText = titles[tab][1];
  }

  refreshCurrentTab();
}

function refreshCurrentTab() {
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
    const res = await fetch('/api/admin/stats');
    const json = await res.json();
    if (json.success) {
      const d = json.data;
      document.getElementById('statTodayPlays').innerText = d.todayPlays || 0;
      document.getElementById('statTotalPlays').innerText = d.totalPlays || 0;
      document.getElementById('statHitRate').innerText = d.cache ? d.cache.hitRate : '100%';
      document.getElementById('statActiveKeys').innerText = d.cache ? d.cache.activeKeysCount : 0;
      document.getElementById('statPoolCount').innerText = d.totalPool || 0;
      const currentHost = window.location.hostname || 'localhost';
      document.getElementById('topDomain').innerText = currentHost;

      // 动态更新拓扑地址
      if (document.getElementById('topologyPortal')) {
        document.getElementById('topologyPortal').innerText = `http://${currentHost}:${d.ports ? d.ports.portal : 8098}`;
      }
      if (document.getElementById('topologyEmby')) {
        document.getElementById('topologyEmby').innerText = `http://${currentHost}:${d.ports ? d.ports.emby : 8097}`;
      }
      if (document.getElementById('topologyAdmin')) {
        document.getElementById('topologyAdmin').innerText = `http://${currentHost}:${d.ports ? d.ports.admin : 8091}`;
      }
    }
  } catch (e) {
    showToast('获取统计数据失败: ' + e.message, 'error');
  }
}

// Emby 设置
async function loadEmbySettings() {
  try {
    const res = await fetch('/api/admin/settings');
    const json = await res.json();
    if (json.success) {
      const s = json.data;
      if (s.emby_upstream_url) document.getElementById('cfgEmbyUrl').value = s.emby_upstream_url;
      if (s.emby_api_key) document.getElementById('cfgEmbyKey').value = s.emby_api_key;
      if (s.acceleration_mode) document.getElementById('cfgAccelMode').value = s.acceleration_mode;
      if (s.cache_ttl_seconds) document.getElementById('cfgTtl').value = s.cache_ttl_seconds;
    }
  } catch (e) { }
}

async function saveEmbySettings(e) {
  e.preventDefault();
  const settings = {
    emby_upstream_url: document.getElementById('cfgEmbyUrl').value.trim(),
    emby_api_key: document.getElementById('cfgEmbyKey').value.trim(),
    acceleration_mode: document.getElementById('cfgAccelMode').value,
    cache_ttl_seconds: document.getElementById('cfgTtl').value.trim()
  };

  try {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings })
    });
    const json = await res.json();
    if (json.success) {
      showToast('Emby 配置已保存生效！');
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
    const res = await fetch('/api/admin/cookie-pool');
    const json = await res.json();
    const tbody = document.getElementById('poolTableBody');
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
  e.preventDefault();
  const name = document.getElementById('poolName').value.trim();
  const cookie = document.getElementById('poolCookie').value.trim();

  showToast('正在验证 115 账号有效性...');
  try {
    const res = await fetch('/api/admin/cookie-pool', {
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
    const res = await fetch(`/api/admin/cookie-pool/${id}`, { method: 'DELETE' });
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
    const res = await fetch('/api/admin/cache');
    const json = await res.json();
    const tbody = document.getElementById('cacheTableBody');
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
    const res = await fetch('/api/admin/cache/flush', { method: 'POST' });
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
    const res = await fetch('/api/admin/files');
    const json = await res.json();
    const tbody = document.getElementById('filesTableBody');
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
    const res = await fetch('/api/admin/logs');
    const json = await res.json();
    const tbody = document.getElementById('logsTableBody');
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
      fetch('/api/admin/users'),
      fetch('/api/admin/settings')
    ]);
    const usersJson = await usersRes.json();
    const settingsJson = await settingsRes.json();

    if (settingsJson.success) {
      const s = settingsJson.data;
      if (s.allow_registration !== undefined) {
        document.getElementById('cfgAllowReg').value = s.allow_registration;
      }
      if (s.max_users_limit !== undefined) {
        document.getElementById('cfgMaxUsers').value = s.max_users_limit;
      }

      const currentCount = usersJson.data ? usersJson.data.length : 0;
      const maxLimit = parseInt(s.max_users_limit || '200', 10);
      const percent = Math.min(100, Math.round((currentCount / maxLimit) * 100));

      document.getElementById('userQuotaText').innerText = `${currentCount} / ${maxLimit} (${percent}%)`;
      const bar = document.getElementById('userQuotaBar');
      bar.style.width = `${percent}%`;
      if (percent >= 100) {
        bar.style.background = 'linear-gradient(90deg, #ef4444, #f97316)';
      } else {
        bar.style.background = 'linear-gradient(90deg, #6366f1, #a855f7)';
      }
    }

    const tbody = document.getElementById('usersTableBody');
    tbody.innerHTML = '';

    if (!usersJson.data || usersJson.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">暂无注册用户</td></tr>';
      return;
    }

    usersJson.data.forEach(user => {
      const tr = document.createElement('tr');
      const isDisabled = user.cookie_status === 'disabled';
      tr.innerHTML = `
        <td>#${user.id}</td>
        <td><strong>${escapeHtml(user.username)}</strong></td>
        <td><span class="badge ${user.cookie_status === 'active' ? 'badge-step1' : 'badge-fallback'}">${escapeHtml(user.cookie_status || '未绑定')}</span></td>
        <td>${user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}</td>
        <td><span class="badge ${isDisabled ? 'badge-fallback' : 'badge-step2'}">${isDisabled ? '已封禁' : '正常'}</span></td>
        <td style="display: flex; gap: 8px;">
          <button class="btn btn-secondary" style="padding: 4px 10px; font-size: 0.75rem;" onclick="toggleUser(${user.id})">
            ${isDisabled ? '解封' : '封禁'}
          </button>
          <button class="btn btn-danger" style="padding: 4px 10px; font-size: 0.75rem;" onclick="deleteUserAccount(${user.id})">
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

async function saveRegSettings(e) {
  e.preventDefault();
  const allow_registration = document.getElementById('cfgAllowReg').value;
  const max_users_limit = document.getElementById('cfgMaxUsers').value.trim();

  try {
    const res = await fetch('/api/admin/settings', {
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
    const res = await fetch(`/api/admin/users/${id}/toggle`, { method: 'POST' });
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
    const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
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
