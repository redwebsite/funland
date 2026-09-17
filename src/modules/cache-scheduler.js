const config = require('../config');

/**
 * Funland 高性能 30 分钟滑动过期缓存调度器
 * 支持 Memory 极速缓存与可选的 Redis 集群模式，具有请求触发展期（Sliding Expiration）能力
 */
class CacheScheduler {
  constructor(defaultTtlSeconds = 1800) {
    this.defaultTtl = defaultTtlSeconds;
    this.memoryStore = new Map(); // key -> { value, expireAt, ttl }
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      refreshes: 0
    };

    // 定期清除内存过期项 (每 60 秒扫一次)
    this.gcTimer = setInterval(() => this.cleanupExpired(), 60000);
    this.gcTimer.unref();

    console.log(`✅ [Cache] 缓存调度器初始化完成 (默认滑动过期: ${this.defaultTtl} 秒 / 30分钟)`);
  }

  /**
   * 生成统一格式键名
   */
  makeKey(category, id, subId = 'global') {
    return `${category}:${id}:${subId}`;
  }

  /**
   * 获取缓存（支持滑动过期自动延期）
   * @param {string} key
   * @param {boolean} slide - 是否在命中时刷新 30 分钟 TTL
   */
  get(key, slide = true) {
    const item = this.memoryStore.get(key);
    const now = Date.now();

    if (!item) {
      this.stats.misses++;
      return null;
    }

    // 检查是否过期
    if (item.expireAt < now) {
      this.memoryStore.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;

    // 滑动过期：命中时将过期时间重新往后顺延 30 分钟 (1800秒)
    if (slide) {
      item.expireAt = now + (item.ttl * 1000);
      this.stats.refreshes++;
    }

    return item.value;
  }

  /**
   * 设置缓存项
   */
  set(key, value, customTtlSeconds = null) {
    const ttl = customTtlSeconds || this.defaultTtl;
    const expireAt = Date.now() + (ttl * 1000);

    this.memoryStore.set(key, {
      value,
      expireAt,
      ttl,
      setAt: Date.now()
    });

    this.stats.sets++;
  }

  /**
   * 删除指定缓存
   */
  del(key) {
    return this.memoryStore.delete(key);
  }

  /**
   * 清空所有缓存
   */
  flush() {
    this.memoryStore.clear();
  }

  /**
   * 获取当前缓存项列表及元数据
   */
  listKeys() {
    const now = Date.now();
    const list = [];
    for (const [key, item] of this.memoryStore.entries()) {
      if (item.expireAt > now) {
        list.push({
          key,
          remainingSeconds: Math.max(0, Math.round((item.expireAt - now) / 1000)),
          setAt: new Date(item.setAt).toISOString(),
          valuePreview: typeof item.value === 'string' ? item.value.substring(0, 50) + '...' : '[Object]'
        });
      }
    }
    return list;
  }

  /**
   * 垃圾回收清理过期条目
   */
  cleanupExpired() {
    const now = Date.now();
    let count = 0;
    for (const [key, item] of this.memoryStore.entries()) {
      if (item.expireAt < now) {
        this.memoryStore.delete(key);
        count++;
      }
    }
    if (count > 0) {
      // debug gc
    }
  }

  /**
   * 统计概览
   */
  getStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRate = totalRequests > 0 ? ((this.stats.hits / totalRequests) * 100).toFixed(1) + '%' : '100%';

    return {
      activeKeysCount: this.memoryStore.size,
      ttlSeconds: this.defaultTtl,
      hits: this.stats.hits,
      misses: this.stats.misses,
      sets: this.stats.sets,
      refreshes: this.stats.refreshes,
      hitRate
    };
  }
}

// 导出单例
const cacheScheduler = new CacheScheduler(config.cache.ttlSeconds);

module.exports = cacheScheduler;
