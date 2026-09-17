require('dotenv').config();
const path = require('path');

const config = {
  domain: process.env.BASE_DOMAIN || 'localhost',
  ports: {
    portal: parseInt(process.env.PORT_PORTAL || '8098', 10),
    admin: parseInt(process.env.PORT_ADMIN || '8091', 10),
    emby: parseInt(process.env.PORT_EMBY || '8097', 10)
  },
  emby: {
    upstreamUrl: process.env.EMBY_UPSTREAM_URL || 'https://xart.fun:443',
    apiKey: process.env.EMBY_API_KEY || ''
  },
  admin: {
    username: process.env.ADMIN_USER || 'admin',
    password: process.env.ADMIN_PASSWORD || 'funland2026',
    jwtSecret: process.env.JWT_SECRET || 'funland-secret-key-2026'
  },
  cache: {
    ttlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '1800', 10),
    redisUrl: process.env.REDIS_URL || ''
  },
  paths: {
    dataDir: path.resolve(process.env.DATA_DIR || './data'),
    dbPath: path.resolve(process.env.DATA_DIR || './data', 'funland.db')
  }
};

module.exports = config;
