/**
 * @file cache-keys.constants.ts
 * @description 统一管理所有 Redis key 前缀和生成函数.
 *
 * 设计原则:
 * 1. 所有 Redis key 必须从此处获取, 禁止在业务代码中硬编码
 * 2. 每个 key 包含 PREFIX (用于 SCAN / 批量操作) 和 build() (生成完整 key)
 * 3. key 命名空间用 ':' 分隔, 遵循 Redis 社区规范
 */

export const CACHE_KEYS = {
  // ==================== Account Query Session ====================

  /**
   * 礼品卡查询 session 上下文缓存.
   * Key 格式: `gc:session:{email}:{countryURL}`
   * Value: JSON (SerializedSession)
   * TTL: SESSION_CACHE_TTL_MS (8 min)
   */
  SESSION: {
    PREFIX: 'gc:session:',
    build: (cacheKey: string): string => `gc:session:${cacheKey}`,
  },

  /**
   * 分布式查询互斥锁.
   * Key 格式: `gc:lock:{email}:{countryURL}`
   * Value: lockId (uuid)
   * TTL: 30s (防死锁)
   */
  LOCK: {
    PREFIX: 'gc:lock:',
    build: (key: string): string => `gc:lock:${key}`,
  },

  /**
   * 地区级预热互斥锁 — 防止多个账号同时预热同一地区.
   * Key 格式: `gc:warmup-region:{regionPath}`
   * Value: 执行预热的 email
   * TTL: 60s (预热超时保护)
   */
  WARMUP_REGION: {
    PREFIX: 'gc:warmup-region:',
    build: (regionPath: string): string => `gc:warmup-region:${regionPath}`,
  },

  /**
   * 地区级已预热账号索引 — O(1) 查找某地区是否有已预热的 session.
   * Key 格式: `gc:warmed:{regionPath}`
   * Value: email (拥有该地区已预热 session 的账号)
   * TTL: 与 SESSION_CACHE_TTL_MS 对齐 (8 min), 与 session 同步过期
   */
  WARMED_ACCOUNT: {
    PREFIX: 'gc:warmed:',
    build: (regionPath: string): string => `gc:warmed:${regionPath}`,
  },

  /**
   * 账号当前绑定地区反向索引 — 追踪账号当前唯一的地区上下文.
   * Key 格式: `gc:account-region:{email}`
   * Value: regionPath (如 '/us', '/jp')
   * TTL: 与 SESSION_CACHE_TTL_MS 对齐 (8 min)
   *
   * 不变量: 一个账号在未退休 (evict/cooldown) 前只能绑定一个地区.
   * saveToCache 写入, evictCache 删除.
   * 兜底扫描时检查此 key — 已绑定其他地区的账号不可分配.
   */
  ACCOUNT_REGION: {
    PREFIX: 'gc:account-region:',
    build: (email: string): string => `gc:account-region:${email}`,
  },

  /**
   * 账号冷却锁 — 查询 5 次后冷却 60 秒, 期间不可初始化或查询.
   * Key 格式: `gc:cooldown:{email}:{countryURL}`
   * Value: '1'
   * TTL: 60s
   */
  COOLDOWN: {
    PREFIX: 'gc:cooldown:',
    build: (cacheKey: string): string => `gc:cooldown:${cacheKey}`,
  },

  /**
   * 地区级并发信号量 — 控制同一地区的最大并发查询数.
   * Key 格式: `gc:region-slots:{regionPath}`
   * Value: Number (当前剩余可用槽位数)
   * TTL: 无 (由业务逻辑管理)
   */
  REGION_SLOTS: {
    PREFIX: 'gc:region-slots:',
    build: (regionPath: string): string => `gc:region-slots:${regionPath}`,
  },

  /**
   * 地区级并发信号量容量 — 记录 REGION_SLOTS 对应的最大槽位数.
   * Key 格式: `gc:region-slot-capacity:{regionPath}`
   * Value: Number (当前地区并发上限)
   * TTL: 与 REGION_SLOTS 对齐
   */
  REGION_SLOT_CAPACITY: {
    PREFIX: 'gc:region-slot-capacity:',
    build: (regionPath: string): string => `gc:region-slot-capacity:${regionPath}`,
  },

  /**
   * 每 cacheKey 的查询使用统计 (触发主动轮换预热).
   * Key 格式: `gc:usage:{email}:{countryURL}`
   * Value: Hash { queryCount, windowStart, lastQueryAt }
   * TTL: ROTATION_WINDOW_MS (1 min)
   */
  USAGE: {
    PREFIX: 'gc:usage:',
    build: (cacheKey: string): string => `gc:usage:${cacheKey}`,
  },

  // ==================== User Account Pool ====================

  /**
   * 账号池条目 — 存储单个账号的完整信息.
   * Key 格式: `pool:acct:{email}`
   * Value: Hash { email, password, twoFAUrl, sessionId, region, status, ... }
   * TTL: 24h (与 USAGE_TTL_SECONDS 对齐)
   */
  ACCOUNT: {
    PREFIX: 'pool:acct:',
    build: (email: string): string => `pool:acct:${email}`,
  },

  /**
   * 账号池 email 集合 — 快速枚举所有已登录账号.
   * Key 格式: `pool:emails`
   * Value: Set { email1, email2, ... }
   * TTL: 无 (手动管理)
   */
  ACCOUNT_SET: 'pool:emails',

  /**
   * 用户组维度账号集合 — 防止不同用户组枚举/使用彼此账号.
   * Key 格式: `pool:emails:{groupKey}`
   * Value: Set { groupKey|email, ... }
   */
  ACCOUNT_GROUP_SET: {
    PREFIX: 'pool:emails:',
    build: (groupKey: string): string => `pool:emails:${groupKey}`,
  },

  /**
   * 账号使用次数计数器 (已有, 保持兼容).
   * Key 格式: `user:pool:usage:{email}`
   * Value: String (number)
   * TTL: 24h
   */
  ACCOUNT_USAGE: {
    PREFIX: 'user:pool:usage:',
    build: (email: string): string => `user:pool:usage:${email}`,
  },

  /**
   * 账号检测互斥锁 — 确保同一账号不被并发请求同时获取.
   * acquireAnySession 获取时 SETNX, 检测完成后 DEL 释放.
   * Key 格式: `pool:detect-lock:{email}`
   * Value: '1'
   * TTL: 30s (防死锁)
   */
  DETECT_LOCK: {
    PREFIX: 'pool:detect-lock:',
    build: (email: string): string => `pool:detect-lock:${email}`,
  },

  // ==================== Login Warmup Job ====================

  /**
   * 批量登录 + 预热任务摘要.
   * Key 格式: `rx:job:login-warmup:{jobId}:summary`
   * Value: Hash
   */
  LOGIN_WARMUP_JOB_SUMMARY: {
    PREFIX: 'rx:job:login-warmup:',
    build: (jobId: string): string => `rx:job:login-warmup:${jobId}:summary`,
  },

  /**
   * 用户账号登录/2FA/relogin 任务流.
   * Key 格式: `rx:stream:user-account-login`
   * Value: Redis Stream entries, field `payload` contains JSON task payload
   */
  USER_ACCOUNT_LOGIN_TASK_STREAM: 'rx:stream:user-account-login',

  /**
   * 用户账号登录任务去重锁.
   * Key 格式: `rx:login-task-dedup:{dedupKey}`
   * Value: '1'
   * TTL: 按任务类型设置
   */
  USER_ACCOUNT_LOGIN_TASK_DEDUP: {
    PREFIX: 'rx:login-task-dedup:',
    build: (dedupKey: string): string => `rx:login-task-dedup:${dedupKey}`,
  },

  /**
   * 用户组业务活跃心跳 — RosettaX 写入, RosettaX-Property 读取后决定是否维持无感刷新.
   * Key 格式: `rx:group-activity:{groupKey}`
   * Value: Hash { groupKey, groupId, source, lastSeenAt, updatedAt }
   * TTL: 比业务空闲判定窗口更长, 防止短时 Redis 抖动导致误停刷新
   */
  GROUP_ACTIVITY: {
    PREFIX: 'rx:group-activity:',
    build: (groupKey: string): string => `rx:group-activity:${groupKey}`,
  },

  /**
   * 用户组业务活跃索引 — 按 lastSeenAt 排序, 供 Property 定时扫描活跃组.
   * Key 格式: `rx:group-activity:index`
   * Value: ZSet { member=groupKey, score=lastSeenAt }
   */
  GROUP_ACTIVITY_INDEX: 'rx:group-activity:index',

  // ==================== Managed Session (Apple ID) ====================

  /**
   * Apple ID 登录会话元数据.
   * Key 格式: `apple:session:{sessionId}`
   * Value: Hash { email, status, loginTime, proxySessionTag, dsid, guid }
   * TTL: 24h
   */
  MANAGED_SESSION: {
    PREFIX: 'apple:session:',
    build: (sessionId: string): string => `apple:session:${sessionId}`,
  },

  /**
   * Apple ID 登录会话 cookies (独立 Hash, 与元数据分离).
   * Key 格式: `apple:session:{sessionId}:cookies`
   * Value: Hash { cookieName → cookieValue }
   * TTL: 24h
   */
  MANAGED_SESSION_COOKIES: {
    PREFIX: 'apple:session:',
    build: (sessionId: string): string => `apple:session:${sessionId}:cookies`,
  },

  /**
   * 邮箱 → sessionId 映射 — 防止同一账号跨 Pod 重复登录.
   * Key 格式: `apple:email2session:{email}`
   * Value: String (sessionId)
   * TTL: 24h (与 session TTL 对齐)
   */
  EMAIL_TO_SESSION: {
    PREFIX: 'apple:email2session:',
    build: (email: string): string => `apple:email2session:${email}`,
  },
} as const;
