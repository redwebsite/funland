// Funland User Portal Client Logic

let qrSession = null;
let qrPollTimer = null;
let currentClient = 'infuse';

document.addEventListener('DOMContentLoaded', () => {
  loadSystemInfo();
  initQrLogin();
});

// 1. 获取系统信息
async function loadSystemInfo() {
  try {
    const res = await fetch('/api/info');
    const json = await res.json();
    if (json.success) {
      const data = json.data;
      if (data.embyServerAddress) {
        document.getElementById('embyServerAddress').innerText = data.embyServerAddress;
      }
    }
  } catch (e) { }
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

  try {
    const res = await fetch(`/api/115/qrcode/status?uid=${uid}&time=${time}&sign=${sign}&username=portal_user`);
    const json = await res.json();

    if (json.status === 'waiting') {
      text.innerText = '打开 115 App 扫一扫';
    } else if (json.status === 'scanned') {
      dot.innerText = '📲';
      text.innerText = '已扫码，请在手机端点击【确认登录】';
    } else if (json.status === 'confirmed') {
      clearInterval(qrPollTimer);
      dot.innerText = '✅';
      text.innerText = '登录授权成功！已绑定至 Funland';
      badge.className = 'qr-status-badge success';
      document.getElementById('boundCard').style.display = 'block';
      document.getElementById('boundUserInfo').innerText = '当前绑定的账号已就绪，播放时将自动提取 115 原画直链。';
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

  try {
    const res = await fetch('/api/user/bind-cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'portal_user', cookie })
    });
    const json = await res.json();
    if (json.success) {
      alert(json.msg || '绑定成功！');
      document.getElementById('boundCard').style.display = 'block';
      document.getElementById('boundUserInfo').innerText = `用户: ${json.data.username || '115账号'} (VIP到期: ${json.data.vipExpire || '未知'})`;
    } else {
      alert(json.error || '绑定失败，请检查 Cookie 完整性');
    }
  } catch (e) {
    alert('网络异常: ' + e.message);
  }
}

// 4. 客户端引导切换
function switchClient(client) {
  currentClient = client;
  document.getElementById('btnClientInfuse').classList.toggle('active', client === 'infuse');
  document.getElementById('btnClientVidhub').classList.toggle('active', client === 'vidhub');
  document.getElementById('btnClientEmby').classList.toggle('active', client === 'emby');

  const stepsContainer = document.getElementById('guideSteps');
  if (client === 'infuse') {
    stepsContainer.innerHTML = `
      <div class="step-item"><div class="step-number">1</div><div class="step-content">打开 Infuse，点击【设置】->【添加文件来源】-> 选择 <strong>Emby</strong>。</div></div>
      <div class="step-item"><div class="step-number">2</div><div class="step-content">输入服务器地址: <code>emby.xxfa.de</code>，端口: <code>8097</code>。</div></div>
      <div class="step-item"><div class="step-number">3</div><div class="step-content">输入你在 Emby 上的账号密码完成登录并等待同步。</div></div>
      <div class="step-item"><div class="step-number">4</div><div class="step-content">点播任何视频，Infuse 自动接收 302 满速直链，享受蓝光原盘丝滑解码。</div></div>
    `;
  } else if (client === 'vidhub') {
    stepsContainer.innerHTML = `
      <div class="step-item"><div class="step-number">1</div><div class="step-content">打开 VidHub，点击【媒体库】->【添加媒体源】-> 选择 <strong>Emby</strong>。</div></div>
      <div class="step-item"><div class="step-number">2</div><div class="step-content">服务器填入 <code>emby.xxfa.de:8097</code> 或选择 HTTPS 填入 <code>emby.xxfa.de</code>。</div></div>
      <div class="step-item"><div class="step-number">3</div><div class="step-content">登录你的 Emby 用户名和密码。</div></div>
      <div class="step-item"><div class="step-number">4</div><div class="step-content">VidHub 播放器原生支持 302 重定向，直接走 115 满速 CDN 播放。</div></div>
    `;
  } else if (client === 'emby') {
    stepsContainer.innerHTML = `
      <div class="step-item"><div class="step-number">1</div><div class="step-content">打开官方 Emby 客户端或在浏览器中访问 <code>http://emby.xxfa.de:8097</code>。</div></div>
      <div class="step-item"><div class="step-number">2</div><div class="step-content">手动输入主机地址: <code>emby.xxfa.de</code>，端口: <code>8097</code>。</div></div>
      <div class="step-item"><div class="step-number">3</div><div class="step-content">登录你的个人 Emby 账号。</div></div>
      <div class="step-item"><div class="step-number">4</div><div class="step-content">播放视频，后台控制台可实时查看到 302 Found 重定向日志。</div></div>
    `;
  }
}

// 5. 复制地址
function copyServerAddress() {
  const text = document.getElementById('embyServerAddress').innerText;
  navigator.clipboard.writeText(text).then(() => {
    alert('已成功复制 Emby 代理地址到剪贴板！');
  }).catch(() => {
    prompt('请长按或复制以下地址:', text);
  });
}
