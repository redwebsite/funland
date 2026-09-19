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
  checkUserDriveStatus();
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
      if (badge) {
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
  if (!btn) return;
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
  checkUserDriveStatus();
  alert('已退出登录');
}

// 弹窗控制
function openAuthModal() {
  if (currentUser) {
    alert(`当前已登录为: ${currentUser}`);
    return;
  }
  const modal = document.getElementById('authModal');
  if (modal) modal.style.display = 'flex';
  switchAuthTab('login');
}

function closeAuthModal() {
  const modal = document.getElementById('authModal');
  if (modal) modal.style.display = 'none';
}

function switchAuthTab(mode) {
  currentAuthMode = mode;
  const tabLogin = document.getElementById('tabAuthLogin');
  const tabReg = document.getElementById('tabAuthReg');
  const quotaAlert = document.getElementById('regQuotaAlert');
  const submitBtn = document.getElementById('btnAuthSubmit');
  const regClosedSection = document.getElementById('regClosedSection');
  const authFieldsGroup = document.getElementById('authFieldsGroup');

  const inputUsername = document.getElementById('authUsername');
  const inputPassword = document.getElementById('authPassword');

  if (mode === 'login') {
    if (tabLogin) tabLogin.classList.add('active');
    if (tabReg) tabReg.classList.remove('active');
    if (quotaAlert) quotaAlert.style.display = 'none';
    if (regClosedSection) regClosedSection.style.display = 'none';
    if (authFieldsGroup) authFieldsGroup.style.display = 'block';
    if (submitBtn) submitBtn.innerText = '立即登录';

    if (inputUsername) {
      inputUsername.placeholder = '请输入用户名';
      inputUsername.removeAttribute('minlength');
    }
    if (inputPassword) {
      inputPassword.placeholder = '请输入密码 (若 Emby 无密码可留空)';
      inputPassword.removeAttribute('required');
      inputPassword.removeAttribute('minlength');
    }
  } else {
    if (tabReg) tabReg.classList.add('active');
    if (tabLogin) tabLogin.classList.remove('active');

    if (inputUsername) {
      inputUsername.placeholder = '请输入用户名 (支持数字/字母/中文)';
      inputUsername.removeAttribute('minlength');
    }
    if (inputPassword) {
      inputPassword.placeholder = '至少 6 位密码';
      inputPassword.setAttribute('required', 'required');
      inputPassword.setAttribute('minlength', '6');
    }

    // 检查注册是否开放
    const isRegOpen = cachedRegInfo ? cachedRegInfo.allowed : true;
    if (!isRegOpen) {
      // 注册已关闭状态
      if (quotaAlert) quotaAlert.style.display = 'none';
      if (authFieldsGroup) authFieldsGroup.style.display = 'none';
      if (regClosedSection) regClosedSection.style.display = 'block';
    } else {
      if (regClosedSection) regClosedSection.style.display = 'none';
      if (authFieldsGroup) authFieldsGroup.style.display = 'block';
      if (quotaAlert) quotaAlert.style.display = 'block';
      if (submitBtn) submitBtn.innerText = '立即注册';
      if (cachedRegInfo && document.getElementById('modalQuotaSlots')) {
        document.getElementById('modalQuotaSlots').innerText = cachedRegInfo.remainingSlots;
      }
    }
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;

  if (currentAuthMode === 'register') {
    if (!username || username.length < 1) {
      alert('请输入有效的用户名');
      return;
    }
    if (!password || password.length < 6) {
      alert('注册时密码须至少 6 位');
      return;
    }
  } else {
    if (!username) {
      alert('请输入用户名');
      return;
    }
  }

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
      checkUserDriveStatus();
    } else {
      alert(json.error || '操作失败');
    }
  } catch (err) {
    alert('请求异常: ' + err.message);
  }
}

// 2. 115 网盘授权与秒存设置状态检查
async function checkUserDriveStatus() {
  const targetUser = currentUser || 'guest_user';
  try {
    const res = await fetch(`/api/user/status?username=${encodeURIComponent(targetUser)}`);
    const json = await res.json();
    if (json.success && json.bound) {
      showDriveSettingsPanel(json);
    } else {
      showDriveAuthPanel();
    }
  } catch (e) {
    showDriveAuthPanel();
  }
}

function showDriveSettingsPanel(data) {
  const boxAuth = document.getElementById('boxDriveAuth');
  const boxSettings = document.getElementById('boxDriveSettings');
  if (boxAuth) boxAuth.style.display = 'none';
  if (boxSettings) {
    boxSettings.style.display = 'flex';
    const uidText = document.getElementById('driveUidDisplay');
    if (uidText) {
      const uidVal = data.uid || (data.data && data.data.userId) || '594679508';
      uidText.innerText = `UID - ${uidVal}`;
    }
    const input = document.getElementById('driveSaveDirInput');
    if (input) {
      input.value = (data.saveDir || '/EmbyCache11').replace(/^\//, '');
    }
    const spaceEl = document.getElementById('driveSpaceQuota');
    if (spaceEl && data.data && data.data.spaceTotal) {
      spaceEl.innerText = `${data.data.spaceTotal} ≤`;
    }
  }
}

function showDriveAuthPanel() {
  const boxAuth = document.getElementById('boxDriveAuth');
  const boxSettings = document.getElementById('boxDriveSettings');
  if (boxSettings) boxSettings.style.display = 'none';
  if (boxAuth) {
    boxAuth.style.display = 'block';
    if (!qrSession) {
      initQrLogin();
    }
  }
}

function toggleDriveEditMode(showEdit) {
  const boxAuth = document.getElementById('boxDriveAuth');
  const boxSettings = document.getElementById('boxDriveSettings');
  const btnCancel = document.getElementById('btnCancelEditDrive');

  if (showEdit) {
    if (boxSettings) boxSettings.style.display = 'none';
    if (boxAuth) boxAuth.style.display = 'block';
    if (btnCancel) btnCancel.style.display = 'inline-block';
    if (!qrSession) initQrLogin();
  } else {
    if (boxAuth) boxAuth.style.display = 'none';
    if (boxSettings) boxSettings.style.display = 'flex';
    if (btnCancel) btnCancel.style.display = 'none';
  }
}

async function saveDriveSettings(customCid = null, customDir = null) {
  const targetUser = currentUser || 'guest_user';
  const input = document.getElementById('driveSaveDirInput');
  const toast = document.getElementById('driveSaveToast');
  let rawDir = customDir || (input ? input.value.trim() : 'EmbyCache11');
  if (!rawDir) rawDir = 'EmbyCache11';
  const cleanDir = rawDir.startsWith('/') ? rawDir : '/' + rawDir;

  try {
    const payload = { username: targetUser, saveDir: cleanDir };
    if (customCid !== null && typeof customCid !== 'undefined') {
      payload.saveCid = String(customCid);
    }
    const res = await fetch('/api/user/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json.success) {
      if (input) input.value = cleanDir.replace(/^\//, '');
      if (toast) {
        toast.innerText = `✅ 秒存文件夹已保存为: ${cleanDir}`;
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, 3000);
      }
      return true;
    } else {
      alert(json.error || '保存失败');
      return false;
    }
  } catch (e) {
    alert('保存异常: ' + e.message);
    return false;
  }
}

// 3. 扫码登录流程
async function initQrLogin() {
  if (qrPollTimer) clearInterval(qrPollTimer);

  const badge = document.getElementById('qrStatusBadge');
  const dot = document.getElementById('qrStatusDot');
  const text = document.getElementById('qrStatusText');
  const img = document.getElementById('qrImg');

  if (dot) dot.innerText = '⏳';
  if (text) text.innerText = '正在生成 115 扫码凭证...';
  if (badge) badge.className = 'qr-status-badge';

  try {
    const res = await fetch('/api/115/qrcode/token', { method: 'POST' });
    const json = await res.json();

    if (json.success && json.qrDataUrl) {
      qrSession = json;
      if (img) img.src = json.qrDataUrl;
      if (dot) dot.innerText = '📱';
      if (text) text.innerText = '打开 115 App 扫一扫';

      // 启动轮询 (每 2 秒一次)
      qrPollTimer = setInterval(pollQrStatus, 2000);
    } else {
      if (text) text.innerText = '获取二维码失败: ' + (json.error || '上游超时');
    }
  } catch (err) {
    if (text) text.innerText = '生成异常: ' + err.message;
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
      if (text) text.innerText = '打开 115 App 扫一扫';
    } else if (json.status === 'scanned') {
      if (dot) dot.innerText = '📲';
      if (text) text.innerText = '已扫码，请在手机端点击【确认登录】';
    } else if (json.status === 'confirmed') {
      clearInterval(qrPollTimer);
      if (dot) dot.innerText = '✅';
      if (text) text.innerText = `授权成功！已绑定至用户: ${targetUser}`;
      if (badge) badge.className = 'qr-status-badge success';
      // 立即无缝切换到网盘设置面板
      showDriveSettingsPanel({
        uid: json.uid115 || '',
        saveDir: '/EmbyCache11',
        data: { spaceTotal: '5 TB' }
      });
      setTimeout(() => {
        checkUserDriveStatus();
        // 核心对齐 NextEmby 体验：扫码后直接自动弹出秒传文件夹选择器，让用户一键点击选择目标文件夹！
        openFolderPicker(true);
      }, 600);
    } else if (json.status === 'expired') {
      clearInterval(qrPollTimer);
      if (dot) dot.innerText = '❌';
      if (text) text.innerText = '二维码已失效，点击刷新';
    }
  } catch (e) { }
}

function refreshQrCode() {
  initQrLogin();
}

// 4. Cookie 手动绑定
function switchBindTab(type) {
  const btnQr = document.getElementById('btnTabQr');
  const btnCookie = document.getElementById('btnTabCookie');
  const panelQr = document.getElementById('panelQr');
  const panelCookie = document.getElementById('panelCookie');

  if (type === 'qr') {
    if (btnQr) btnQr.classList.add('active');
    if (btnCookie) btnCookie.classList.remove('active');
    if (panelQr) panelQr.style.display = 'block';
    if (panelCookie) panelCookie.style.display = 'none';
  } else {
    if (btnCookie) btnCookie.classList.add('active');
    if (btnQr) btnQr.classList.remove('active');
    if (panelQr) panelQr.style.display = 'none';
    if (panelCookie) panelCookie.style.display = 'block';
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
      showDriveSettingsPanel({
        uid: (json.data && (json.data.uid115 || json.data.userId)) || '',
        saveDir: (json.data && json.data.saveDir) || '/EmbyCache11',
        data: json.data || { spaceTotal: '5 TB' }
      });
      checkUserDriveStatus();
      setTimeout(() => {
        openFolderPicker(true);
      }, 600);
    } else {
      alert(json.error || '绑定失败，请检查 Cookie 完整性');
    }
  } catch (e) {
    alert('网络异常: ' + e.message);
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

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==================== 115 交互式文件夹选择器 (NextEmby 对齐) ====================
let currentPickerCid = '0';
let currentPickerPath = [{ cid: '0', name: '根目录' }];
let selectedFolderState = { cid: '0', name: '根目录', fullPath: '/' };

function openFolderPicker(autoPrompt = false) {
  const modal = document.getElementById('folderPickerModal');
  if (!modal) return;

  const title = document.getElementById('folderPickerTitle');
  const sub = document.getElementById('folderPickerSubtitle');

  if (autoPrompt) {
    if (title) title.innerText = '🎉 115 授权成功！请选择秒存文件夹';
    if (sub) sub.innerText = '请点击选择已存在的网盘文件夹，作为后续播放秒传转存的存储位置';
  } else {
    if (title) title.innerText = '选择 115 秒存文件夹';
    if (sub) sub.innerText = '点击目录进入下级，或直接点击「选定」设为默认秒存路径';
  }

  modal.style.display = 'flex';
  loadUserFolders('0');
}

function closeFolderPicker() {
  const modal = document.getElementById('folderPickerModal');
  if (modal) modal.style.display = 'none';
}

async function loadUserFolders(cid = '0') {
  const container = document.getElementById('folderListContainer');
  const targetUser = currentUser || 'guest_user';
  currentPickerCid = String(cid || '0');

  if (container) {
    container.innerHTML = `
      <div class="folder-loading">
        <div class="spinner-small"></div>
        <span>正在读取 115 网盘目录...</span>
      </div>
    `;
  }

  try {
    const res = await fetch(`/api/115/folders?username=${encodeURIComponent(targetUser)}&cid=${encodeURIComponent(currentPickerCid)}`);
    const json = await res.json();

    if (!json.success) {
      if (container) {
        container.innerHTML = `
          <div class="folder-empty">
            <span style="font-size: 2rem;">⚠️</span>
            <span>读取网盘文件夹失败: ${escapeHtml(json.error || '未知错误')}</span>
            <button class="btn-tool-pill" onclick="loadUserFolders('${currentPickerCid}')" style="margin-top: 8px;">重试</button>
          </div>
        `;
      }
      return;
    }

    currentPickerPath = json.path || [{ cid: '0', name: '根目录' }];
    renderBreadcrumbs(currentPickerPath);

    // 默认选定当前所在目录
    const currPathStr = json.fullPath || '/';
    const currDirName = currentPickerPath.length > 1 ? currentPickerPath[currentPickerPath.length - 1].name : '根目录';
    selectFolder(currentPickerCid, currDirName, currPathStr);

    const folders = json.folders || [];
    if (folders.length === 0) {
      if (container) {
        container.innerHTML = `
          <div class="folder-empty">
            <span style="font-size: 2rem;">📂</span>
            <span>当前目录下没有子文件夹</span>
            <p style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">您可以点击上方「➕ 新建文件夹」或直接点击下方「确定使用此目录」</p>
          </div>
        `;
      }
      return;
    }

    let html = '';
    // 当前文件夹选择项（若处于非根目录，提供快速选中当前目录条目）
    if (currentPickerCid !== '0') {
      html += `
        <div class="folder-item selected" onclick="selectFolder('${escapeHtml(currentPickerCid)}', '${escapeHtml(currDirName)}', '${escapeHtml(currPathStr)}')" style="border-style: dashed; border-color: rgba(56, 189, 248, 0.4);">
          <div class="folder-item-left">
            <span class="folder-item-icon">📍</span>
            <span class="folder-item-name" style="color: #38bdf8; font-weight: 600;">使用当前所在目录: ${escapeHtml(currPathStr)}</span>
          </div>
          <div class="folder-item-right">
            <span class="folder-item-count">当前</span>
          </div>
        </div>
      `;
    }

    for (const f of folders) {
      const itemFullPath = currPathStr === '/' ? `/${f.name}` : `${currPathStr}/${f.name}`;
      const isSel = selectedFolderState && selectedFolderState.cid === f.cid;
      html += `
        <div class="folder-item ${isSel ? 'selected' : ''}" id="folderItem_${f.cid}" onclick="selectFolder('${escapeHtml(f.cid)}', '${escapeHtml(f.name)}', '${escapeHtml(itemFullPath)}')" ondblclick="enterFolder('${escapeHtml(f.cid)}')">
          <div class="folder-item-left">
            <span class="folder-item-icon">📁</span>
            <span class="folder-item-name">${escapeHtml(f.name)}</span>
          </div>
          <div class="folder-item-right">
            ${f.count ? `<span class="folder-item-count">${f.count} 项</span>` : ''}
            <button type="button" class="btn-folder-enter" onclick="event.stopPropagation(); enterFolder('${escapeHtml(f.cid)}')" title="进入子目录">
              进入 ➔
            </button>
          </div>
        </div>
      `;
    }

    if (container) container.innerHTML = html;
  } catch (err) {
    if (container) {
      container.innerHTML = `
        <div class="folder-empty">
          <span style="font-size: 2rem;">❌</span>
          <span>网络请求异常: ${escapeHtml(err.message)}</span>
        </div>
      `;
    }
  }
}

function renderBreadcrumbs(pathArray) {
  const breadcrumbs = document.getElementById('folderBreadcrumbs');
  if (!breadcrumbs) return;

  let html = '';
  for (let i = 0; i < pathArray.length; i++) {
    const p = pathArray[i];
    const isLast = i === pathArray.length - 1;
    if (i > 0) {
      html += `<span class="crumb-sep">/</span>`;
    }
    html += `
      <span class="crumb ${isLast ? 'active' : ''}" onclick="loadUserFolders('${escapeHtml(p.cid)}')">
        ${escapeHtml(p.name)}
      </span>
    `;
  }
  breadcrumbs.innerHTML = html;
}

function enterFolder(cid) {
  loadUserFolders(cid);
}

function selectFolder(cid, name, fullPath) {
  selectedFolderState = { cid: String(cid), name, fullPath };

  // 更新所有文件夹高亮状态
  document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('selected'));
  const activeEl = document.getElementById(`folderItem_${cid}`);
  if (activeEl) activeEl.classList.add('selected');

  // 更新底部选定路径
  const display = document.getElementById('selectedFolderDisplay');
  const cidDisplay = document.getElementById('selectedCidDisplay');
  if (display) display.innerText = fullPath;
  if (cidDisplay) {
    cidDisplay.innerText = `CID: ${cid}`;
    cidDisplay.style.display = 'inline-block';
  }
}

async function confirmFolderSelection() {
  if (!selectedFolderState) {
    alert('请先选择一个目标文件夹');
    return;
  }

  const success = await saveDriveSettings(selectedFolderState.cid, selectedFolderState.fullPath);
  if (success) {
    closeFolderPicker();
  }
}

async function promptCreateFolder() {
  const targetUser = currentUser || 'guest_user';
  const folderName = prompt('请输入新文件夹名称:');
  if (!folderName || !folderName.trim()) return;

  try {
    const res = await fetch('/api/115/folders/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: targetUser,
        pid: currentPickerCid,
        name: folderName.trim()
      })
    });
    const json = await res.json();
    if (json.success) {
      alert(`文件夹「${folderName.trim()}」创建成功！`);
      loadUserFolders(currentPickerCid);
    } else {
      alert(json.error || '创建文件夹失败');
    }
  } catch (e) {
    alert('请求异常: ' + e.message);
  }
}

function refreshCurrentFolder() {
  loadUserFolders(currentPickerCid);
}

// 全局函数导出
window.saveDriveSettings = saveDriveSettings;
window.toggleDriveEditMode = toggleDriveEditMode;
window.checkUserDriveStatus = checkUserDriveStatus;
window.switchBindTab = switchBindTab;
window.refreshQrCode = refreshQrCode;
window.submitManualCookie = submitManualCookie;
window.switchAuthTab = switchAuthTab;
window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.handleAuthSubmit = handleAuthSubmit;
window.copyServerAddress = copyServerAddress;
window.logoutUser = logoutUser;
window.openFolderPicker = openFolderPicker;
window.closeFolderPicker = closeFolderPicker;
window.loadUserFolders = loadUserFolders;
window.enterFolder = enterFolder;
window.selectFolder = selectFolder;
window.confirmFolderSelection = confirmFolderSelection;
window.promptCreateFolder = promptCreateFolder;
window.refreshCurrentFolder = refreshCurrentFolder;
