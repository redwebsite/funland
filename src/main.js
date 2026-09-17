const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const path = require('path');
const config = require('./config');
const { dbService } = require('./db/database');
const { createEmbyMiddleware } = require('./modules/emby-middleware');
const adminRouter = require('./routes/admin-api');
const userRouter = require('./routes/user-api');

// ==========================================
// 1. 服务 1: 用户中心与公共门户 (8098 端口)
// ==========================================
const portalApp = express();
portalApp.use(cors());
portalApp.use(bodyParser.json({ limit: '10mb' }));
portalApp.use(bodyParser.urlencoded({ extended: true }));
portalApp.use(morgan('short'));

// 挂载 API
portalApp.use('/api', userRouter);

// 静态前端资源配置：严格禁止浏览器与代理CDN强缓存 HTML/JS/CSS，保障每次发布即时生效
const staticOptions = {
  etag: false,
  maxAge: 0,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
};

// 静态前端资源 (用户门户)
portalApp.use(express.static(path.join(__dirname, 'public/portal'), staticOptions));

// 本地便利路由：允许在 8098 端口直接通过 /admin 访问管理后台
portalApp.use('/admin', express.static(path.join(__dirname, 'public/admin'), staticOptions));
portalApp.use('/api/admin', adminRouter);

// 健康检查端点
portalApp.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Funland Portal', version: '1.0.0' });
});


// ==========================================
// 2. 服务 2: 管理控制台 (8091 端口)
// ==========================================
const adminApp = express();
adminApp.use(cors());
adminApp.use(bodyParser.json({ limit: '10mb' }));
adminApp.use(bodyParser.urlencoded({ extended: true }));
adminApp.use(morgan('short'));

// 挂载管理 API
adminApp.use('/api/admin', adminRouter);
adminApp.use('/api', userRouter); // 方便管理端测试扫码

// 静态前端资源 (管理控制台)
adminApp.use(express.static(path.join(__dirname, 'public/admin'), staticOptions));

// 首页重定向与健康检查
adminApp.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Funland Admin Console', version: '1.0.0' });
});


// ==========================================
// 3. 服务 3: Emby 播放请求中间件 (8097 端口)
// ==========================================
const embyApp = express();
embyApp.use(cors());
// 注意：代理流不要全局使用 body-parser，以保证 WebSocket 和多媒体流原始传输
embyApp.use(createEmbyMiddleware());


// ==========================================
// 4. 统一启动所有服务
// ==========================================
function startServer() {
  const pPortal = config.ports.portal;
  const pAdmin = config.ports.admin;
  const pEmby = config.ports.emby;
  const domain = config.domain;

  const serverPortal = portalApp.listen(pPortal, '0.0.0.0', () => {
    console.log(`🌐 [1/3] 用户中心 (Portal) 启动成功: http://0.0.0.0:${pPortal} (外网: http://${domain}:${pPortal})`);
  });

  const serverAdmin = adminApp.listen(pAdmin, '0.0.0.0', () => {
    console.log(`🛡️ [2/3] 管理控制台 (Admin) 启动成功: http://0.0.0.0:${pAdmin} (外网: http://admin.${domain}:${pAdmin})`);
    console.log(`    (也可通过 http://0.0.0.0:${pPortal}/admin 直接访问)`);
  });

  const serverEmby = embyApp.listen(pEmby, '0.0.0.0', () => {
    console.log(`🎬 [3/3] Emby 播放中间件 (Proxy) 启动成功: http://0.0.0.0:${pEmby} (外网: http://emby.${domain}:${pEmby})`);
    console.log(`    (上游目标: ${dbService.getSetting('emby_upstream_url', config.emby.upstreamUrl)})`);
  });

  console.log('\n======================================================');
  console.log('🚀 Funland (Next-Gen Emby & 115 Acceleration) 运行中');
  console.log('======================================================\n');

  // 优雅退出处理
  const shutdown = () => {
    console.log('\n🛑 正在停止 Funland 各服务...');
    serverPortal.close();
    serverAdmin.close();
    serverEmby.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer();
