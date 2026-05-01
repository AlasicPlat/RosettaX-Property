/** 使用次数 Redis TTL (秒) — 24 小时 */
export const USER_POOL_USAGE_TTL_SECONDS = 24 * 3600;
/** 触发账号轮换提示的使用次数阈值 */
export const USER_POOL_ROTATION_THRESHOLD = 4;
/** 后台 relogin 锁 TTL (毫秒) — 覆盖 Apple 登录和后续预热 */
export const RELOGIN_LOCK_TTL_MS = 10 * 60 * 1000;
/** 定时扫描每轮最多处理的过期账号数 */
export const RELOGIN_EXPIRED_BATCH_LIMIT = 50;

/**
 * @description 账号池条目 — 跟踪单个用户账号的运行时状态.
 */
export interface PoolEntry {
  /** 账号所属用户组; null 表示历史/全局资源池 */
  groupId?: number | null;
  /** Apple ID 邮箱 */
  email: string;
  /** 密码; 仅用于内部登录和 relogin */
  password: string;
  /** 2FA 验证码获取 URL */
  twoFAUrl?: string;
  /** SessionManagerService 分配的 sessionId */
  sessionId?: string;
  /** 账号所属地区 */
  region: string;
  /** 账号余额显示 */
  creditDisplay?: string;
  /** 账号名称 */
  name?: string;
  /** 本地使用次数; 与 Redis 同步 */
  usageCount: number;
  /** 最后使用时间戳 */
  lastUsedAt: number;
  /** 账号状态 */
  status: 'active' | 'expired' | 'unused' | 'login_failed' | 'needs_2fa';
  /** 登录或运行时错误信息 */
  errorMessage?: string;
}

/**
 * @description 批量登录单个账号的结果.
 */
export interface UserLoginResult {
  email: string;
  status: 'success' | 'needs_2fa' | 'failed';
  sessionId?: string;
  region?: string;
  creditDisplay?: string;
  name?: string;
  errorMessage?: string;
}

/**
 * @description 账号池状态摘要.
 */
export interface PoolStatus {
  total: number;
  active: number;
  cnAccounts: number;
  expired: number;
  unused: number;
  needs2fa: number;
  loginFailed: number;
  accounts: Array<{
    email: string;
    region: string;
    status: string;
    usageCount: number;
    creditDisplay?: string;
    name?: string;
  }>;
}

/**
 * @description 批量登录预热任务操作者上下文.
 */
export interface LoginWarmupOperator {
  source?: string;
  adminId?: number;
  username?: string;
  role?: string;
  groupId?: number | null;
}

/**
 * @description 登录预热任务输入账号.
 */
export interface LoginWarmupAccountInput {
  email: string;
  password: string;
  twoFAUrl?: string;
}

/**
 * @description 登录后给查询 session 预热事件使用的账号凭据.
 */
export interface WarmupAccountCredential {
  email: string;
  password: string;
  accountKey: string;
  groupId: number | null;
}

/**
 * @description 批量登录执行选项.
 */
export interface LoginWarmupRunOptions {
  jobId?: string;
  awaitWarmup?: boolean;
}

/**
 * @description 活跃账号凭据 — 供余额查询预热或兜底选号使用.
 */
export interface ActiveAccountCredential {
  email: string;
  password: string;
  accountKey: string;
  groupId: number | null;
}
