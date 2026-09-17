// Funland User Portal Client Logic

let qrSession = null;
let qrPollTimer = null;
let currentClient = 'infuse';
let currentUser = localStorage.getItem('funland_user') || null;
let currentAuthMode = 'login';
let cachedRegInfo = null;

document.addEventListener('DOMContentLoaded', () => {
  loadSystemInfo();
  loadRegInfo();
  updateUserUi();
  initQrLogin();
});

// 1. 获取系统信息
async function loadSystemInfo() {
  const currentHost = window.location.hostname || 'localhost';
  const embyPort = 8097;
  const isLocalOrIp = /^(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.)/.test(currentHost) || /^[0-9.]+$/.test(currentHost);

  // 默认自适应当前访问主机的 8097 端口
  let displayHost = currentHost;
  let displayAddress = `http://${currentHost}:${embyPort}`;

  try {
    const res = await fetch('/api/info');
    const json = await res.json();
    if (json.success && json.data) {
      const data = json.data;
      const port = (data.ports && data.ports.emby) || embyPort;
      if (data.domain && data.domain !== 'localhost' && !isLocalOrIp) {
        displayHost = data.domain.startsWith('emby.') ? data.domain : `emby.${data.domain}`;
        displayAddress = `http://${displayHost}:${port}`;
      } else {
        displayAddress = `http://${currentHost}:${port}`;
      }
    }
  } catch (e) { }

  if (document.getElementById('embyServerAddress')) {
    document.getElementById('embyServerAddress').innerText = displayAddress;
  }
  if (document.getElementById('embyHostOnly')) {
    document.getElementById('embyHostOnly').innerText = displayHost;
  }
}

// 1.1 获取注册状态与名额
async function loadRegInfo() {
  try {
    const res = await fetch('/api/user/reg-info');
    const json = await res.json();
    if (json.success) {
      cachedRegInfo = json.data;
      const badge = document.getElementById('navRegBadge');
      if (!cachedRegInfo.isSwitchOpen) {
        badge.innerText = '⛔ 注册已关闭';
        badge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
        badge.style.color = '#f87171';
        badge.style.background = 'rgba(239, 68, 68, 0.15)';
      } else if (cachedRegInfo.remainingSlots <= 0) {
        badge.innerText = `⚠️ 名额已满 (${cachedRegInfo.maxUsersLimit}人)`;
        badge.style.borderColor = 'rgba(245, 158, 11, 0.4)';
        badge.style.color = '#fbbf24';
        badge.style.background = 'rgba(245, 158, 11, 0.15)';
      } else {
        badge.innerText = `🟢 开放注册 (${cachedRegInfo.remainingSlots}/${cachedRegInfo.maxUsersLimit})`;
        badge.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        badge.style.color = '#34d399';
        badge.style.background = 'rgba(16, 185, 129, 0.15)';
      }

      if (document.getElementById('modalQuotaSlots')) {
        document.getElementById('modalQuotaSlots').innerText = cachedRegInfo.remainingSlots;
      }
    }
  } catch (e) { }
}

// 用户状态显示更新
function updateUserUi() {
  const btn = document.getElementById('btnUserAuth');
  if (currentUser) {
    btn.innerHTML = `<span>👤 ${escapeHtml(currentUser)}</span> <span onclick="logoutUser(event)" style="margin-left: 6px; opacity: 0.75;" title="退出登录">退出</span>`;
    btn.style.background = 'rgba(99, 102, 241, 0.3)';
    btn.style.border = '1px solid rgba(99, 102, 241, 0.5)';
  } else {
    btn.innerHTML = '👤 登录 / 注册';
    btn.style.background = 'var(--gradient-hero)';
    btn.style.border = 'none';
  }
}

function logoutUser(e) {
  if (e) e.stopPropagation();
  localStorage.removeItem('funland_user');
  currentUser = null;
  updateUserUi();
  alert('已退出登录');
}

// 弹窗控制
function openAuthModal() {
  if (currentUser) {
    alert(`当前已登录为: ${currentUser}`);
    return;
  }
  document.getElementById('authModal').style.display = 'flex';
  switchAuthTab('login');
}

function closeAuthModal() {
  document.getElementById('authModal').style.display = 'none';
}

function switchAuthTab(mode) {
  currentAuthMode = mode;
  const tabLogin = document.getElementById('tabAuthLogin');
  const tabReg = document.getElementById('tabAuthReg');
  const quotaAlert = document.getElementById('regQuotaAlert');
  const submitBtn = document.getElementById('btnAuthSubmit');

  if (mode === 'login') {
    tabLogin.classList.add('active');
    tabReg.classList.remove('active');
    quotaAlert.style.display = 'none';
    submitBtn.innerText = '立即登录';
  } else {
    tabReg.classList.add('active');
    tabLogin.classList.remove('active');
    quotaAlert.style.display = 'block';
    submitBtn.innerText = '立即注册';

    if (cachedRegInfo) {
      document.getElementById('modalQuotaSlots').innerText = cachedRegInfo.remainingSlots;
      if (!cachedRegInfo.allowed) {
        alert(cachedRegInfo.statusText);
      }
    }
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value.trim();

  const url = currentAuthMode === 'login' ? '/api/user/login' : '/api/user/register';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const json = await res.json();

    if (json.success) {
      alert(json.msg || (currentAuthMode === 'login' ? '登录成功！' : '注册成功！'));
      currentUser = username;
      localStorage.setItem('funland_user', username);
      closeAuthModal();
      updateUserUi();
      loadRegInfo();
    } else {
      alert(json.error || '操作失败');
    }
  } catch (err) {
    alert('请求异常: ' + err.message);
  }
}

// 2. 扫码登录流程
async function initQrLogin() {
  if (qrPollTimer) clearInterval(qrPollTimer);

  const badge = document.getElementById('qrStatusBadge');
  const dot = document.getElementById('qrStatusDot');
  const text = document.getElementById('qrStatusText');
  const img = document.getElementById('qrImg');

  dot.innerText = '⏳';
  text.innerText = '正在生成 115 扫码凭证...';
  badge.className = 'qr-status-badge';

  try {
    const res = await fetch('/api/115/qrcode/token', { method: 'POST' });
    const json = await res.json();

    if (json.success && json.qrDataUrl) {
      qrSession = json;
      img.src = json.qrDataUrl;
      dot.innerText = '📱';
      text.innerText = '打开 115 App 扫一扫';

      // 启动轮询 (每 2 秒一次)
      qrPollTimer = setInterval(pollQrStatus, 2000);
    } else {
      text.innerText = '获取二维码失败: ' + (json.error || '上游超时');
    }
  } catch (err) {
    text.innerText = '生成异常: ' + err.message;
  }
}

async function pollQrStatus() {
  if (!qrSession) return;
  const { uid, time, sign } = qrSession;
  const badge = document.getElementById('qrStatusBadge');
  const dot = document.getElementById('qrStatusDot');
  const text = document.getElementById('qrStatusText');
  const targetUser = currentUser || 'guest_user';

  try {
    const res = await fetch(`/api/115/qrcode/status?uid=${uid}&time=${time}&sign=${sign}&username=${encodeURIComponent(targetUser)}`);
    const json = await res.json();

    if (json.status === 'waiting') {
      text.innerText = '打开 115 App 扫一扫';
    } else if (json.status === 'scanned') {
      dot.innerText = '📲';
      text.innerText = '已扫码，请在手机端点击【确认登录】';
    } else if (json.status === 'confirmed') {
      clearInterval(qrPollTimer);
      dot.innerText = '✅';
      text.innerText = `授权成功！已绑定至用户: ${targetUser}`;
      badge.className = 'qr-status-badge success';
      document.getElementById('boundCard').style.display = 'block';
      document.getElementById('boundUserInfo').innerText = `用户【${targetUser}】已完成 115 网盘授权，播放时将自动提取 115 满速原画直链。`;
    } else if (json.status === 'expired') {
      clearInterval(qrPollTimer);
      dot.innerText = '❌';
      text.innerText = '二维码已失效，点击刷新';
    }
  } catch (e) { }
}

function refreshQrCode() {
  initQrLogin();
}

// 3. Cookie 手动绑定
function switchBindTab(type) {
  const btnQr = document.getElementById('btnTabQr');
  const btnCookie = document.getElementById('btnTabCookie');
  const panelQr = document.getElementById('panelQr');
  const panelCookie = document.getElementById('panelCookie');

  if (type === 'qr') {
    btnQr.classList.add('active');
    btnCookie.classList.remove('active');
    panelQr.style.display = 'block';
    panelCookie.style.display = 'none';
  } else {
    btnCookie.classList.add('active');
    btnQr.classList.remove('active');
    panelQr.style.display = 'none';
    panelCookie.style.display = 'block';
  }
}

async function submitManualCookie() {
  const cookie = document.getElementById('manualCookie').value.trim();
  if (!cookie) {
    alert('请输入有效的 115 Cookie 字符串');
    return;
  }

  const targetUser = currentUser || 'guest_user';
  try {
    const res = await fetch('/api/user/bind-cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: targetUser, cookie })
    });
    const json = await res.json();
    if (json.success) {
      alert(json.msg || '绑定成功！');
      document.getElementById('boundCard').style.display = 'block';
      document.getElementById('boundUserInfo').innerText = `用户【${targetUser}】已绑定 115 账号: ${json.data.username || '115账号'} (VIP到期: ${json.data.vipExpire || '未知'})`;
    } else {
      alert(json.error || '绑定失败，请检查 Cookie 完整性');
    }
  } catch (e) {
    alert('网络异常: ' + e.message);
  }
}

// 4. 通用连接说明
// 整合通用连接参数，适配全部 Emby 客户端 (Infuse / VidHub / Fileball / SenPlayer / 官方客户端)

// 5. 复制地址
function copyServerAddress() {
  const text = document.getElementById('embyServerAddress').innerText;
  navigator.clipboard.writeText(text).then(() => {
    alert('已成功复制 Emby 代理地址到剪贴板！');
  }).catch(() => {
    prompt('请长按或复制以下地址:', text);
  });
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
