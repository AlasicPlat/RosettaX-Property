/**
 * @file serialized-session.interface.ts
 * @description Redis 中存储的 session 序列化数据结构定义.
 *
 * 设计约束:
 * - 所有字段必须为 JSON 可序列化类型 (无 Map / Set / class 实例)
 * - Map<string, string> → Record<string, string>
 * - 密码明文存储 (内部服务, Redis 处于内网)
 */

/**
 * @description 序列化的账号信息 — 对应 AccountInfo 接口.
 *
 * 与 AccountInfo 的差异:
 * - `loginCookies: Map<string, string>` → `loginCookies: Record<string, string>`
 */
export interface SerializedAccountInfo {
  /** Apple ID 邮箱 */
  acc: string;
  /** 密码 (明文, 内部服务) */
  pwd: string;
  /** 账号是否可用 */
  available: boolean;
  /** 是否已登录 */
  isLogin: boolean;
  /** 登录 cookies — Map 序列化为 Record */
  loginCookies: Record<string, string>;
}

/**
 * @description 序列化的查询上下文 — 对应 AccountSessionContext 接口.
 */
export interface SerializedContext {
  currentAccountIndex: number;
  accountInfoList: SerializedAccountInfo[];
  x_aos_stk: string;
  x_as_actk: string;
  server: string;
  countryURL: string;
  queryURL: string;
  internalReturnCode: number;
  beRiskCtrl: boolean;
  maxAttemptReached: boolean;
}

/**
 * @description 完整的序列化 session — 存入 Redis 的完整数据.
 *
 * 包含:
 * - 已初始化的查询上下文 (含 token, URL, 账号列表)
 * - 会话 cookies (含 myacinfo 等)
 * - 创建时间戳 (用于 TTL 校验)
 * - 使用的账号邮箱 (用于日志)
 */
export interface SerializedSession {
  /** 序列化的查询上下文 */
  context: SerializedContext;
  /** cookies — Map<name, value> 序列化为 Record */
  cookies: Record<string, string>;
  /** 缓存创建时间戳 (ms) */
  createdAt: number;
  /** Redis session 使用的 TTL (ms), 由接口返回 Cookie 过期时间推导 */
  ttlMs?: number;
  /** 预计 Redis session 过期时间戳 (ms) */
  expiresAt?: number;
  /** 使用的账号邮箱 */
  email: string;
}

/**
 * @description 序列化的使用统计 — 对应 sessionUsageStats 的 value.
 */
export interface SerializedUsageStats {
  /** 时间窗口内的查询次数 */
  queryCount: number;
  /** 时间窗口起始时间 (ms) */
  windowStart: number;
  /** 最后一次查询时间 (ms) */
  lastQueryAt: number;
}

/**
 * @description 序列化的账号池条目 — 对应 PoolEntry 接口.
 *
 * 所有字段均为 JSON 原始类型, 可直接存入 Redis Hash.
 */
export interface SerializedPoolEntry {
  /** 账号所属用户组; null 表示历史/全局账号 */
  groupId?: number | null;
  email: string;
  password: string;
  twoFAUrl?: string;
  sessionId?: string;
  region: string;
  creditDisplay?: string;
  name?: string;
  usageCount: number;
  lastUsedAt: number;
  status: 'active' | 'expired' | 'unused' | 'login_failed' | 'needs_2fa';
  errorMessage?: string;
}

/**
 * @description 批量登录与预热任务摘要 — RosettaX 写入 Redis, AdminServer 只读展示.
 */
export interface SerializedLoginWarmupJobSummary {
  jobId: string;
  status: 'queued' | 'logging_in' | 'warming' | 'completed' | 'partial_failed' | 'failed';
  phase: 'queued' | 'logging_in' | 'warming' | 'done';
  groupId: number | null;
  adminId?: number;
  source?: string;
  resultJson?: string;
  nextPollMs?: number;
  createdAt: number;
  updatedAt: number;
  loginTotal: number;
  loginFinished: number;
  loginSuccess: number;
  loginFailed: number;
  loginNeeds2fa: number;
  warmupTotal: number;
  warmupFinished: number;
  warmupSuccess: number;
  warmupFailed: number;
  errorMessage?: string;
}

/**
 * @description 用户组业务活跃心跳快照.
 *
 * RosettaX 在 GiftCardChecker/GiftCardExchanger 入口写入该结构,
 * RosettaX-Property 按 lastSeenAt 判断是否需要继续维持无感刷新。
 */
export interface SerializedGroupActivity {
  /** 用户组 Redis key 片段, 如 global 或 g1 */
  groupKey: string;
  /** 用户组 ID; null 表示历史/全局资源池 */
  groupId: number | null;
  /** 最近一次触发活跃心跳的业务来源 */
  source: string;
  /** 最近业务使用时间戳 (ms) */
  lastSeenAt: number;
}

/**
 * @description 地区检测选号所需的最小账号字段.
 *
 * 只包含 session 分配和公平排序需要的字段, 避免检测轮询频繁读取账号密码等完整 Hash.
 */
export interface SerializedActiveSessionCandidate {
  /** 用户组内账号身份 key */
  accountKey: string;
  /** Apple ID 原始邮箱, 仅用于日志和上层账号状态更新 */
  email: string;
  /** 已登录 managed session ID */
  sessionId: string;
  /** 账号登录地区 */
  region: string;
  /** 账号使用次数, 用于最少使用优先 */
  usageCount: number;
}
