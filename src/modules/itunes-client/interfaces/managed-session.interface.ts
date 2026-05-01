/**
 * @file managed-session.interface.ts
 * @description 运行时会话相关的 TypeScript 接口定义.
 *
 * 对标 Java AccountManager.ManagedAccount 内部类 + AppleAccount POJO,
 * 将 Java 的有状态对象拆分为不可变接口,供 SessionManagerService 管理.
 *
 * Reference: @docs AccountManager.java L33-85 (ManagedAccount)
 * Reference: @docs AppleAccount.java (model POJO)
 * Reference: @docs LoginResult.java (登录结果枚举)
 */

// ─── 运行时账号数据 ───────────────────────────────────────────

/**
 * @description 登录成功后从 MZFinance authenticate 响应中提取的账号运行时数据.
 *
 * 对标 Java AppleAccount POJO 的全部可变字段.
 * passwordToken / clearToken 是后续 commerce API 认证的关键凭据.
 */
export interface SessionAccountData {
  email: string;
  name: string;
  /** MZFinance 认证令牌 — 用于 X-Token header 和 cookie 回退认证 */
  passwordToken: string;
  /** Apple 内部用户标识 (dsPersonId / DSID) — 拼接 cookie key 和请求 header */
  directoryServicesId: string;
  /** X-Apple-Store-Front — 决定商店区域和语言 (如 "143465-19,29") */
  storeFront: string;
  /** 后续请求路由标识 — 用于选择正确的 Apple 后端 pod (如 "60") */
  pod: string;
  /** 短效会话凭证 (可选) */
  clearToken: string | null;
  /** 最后已知余额 (数值, 如 "1311811") — 非展示用途 */
  creditBalance: string | null;
  /** 最后已知余额 (格式化显示, 如 "¥0.00") — 展示用途 */
  creditDisplay: string | null;
  /** 免费歌曲余额 */
  freeSongBalance: string | null;
}

// ─── 运行时会话 ───────────────────────────────────────────────

/**
 * @description 受管理的登录会话 — 对标 Java AccountManager.ManagedAccount.
 *
 * 每个 Apple ID 登录后产生一个独立会话,包含:
 * - 账号运行时数据 (account)
 * - 认证 cookies (sessionCookies: mz_at_ssl / mt-tkn / mz_at0 等)
 * - 代理绑定 (proxySessionTag) — 同一 session 所有请求走同一出口 IP (Decodo sticky session)
 * - 密码 (仅内存, 用于 re-login 刷新余额)
 *
 * 会话生命周期: login → logged_in → logout/expire
 */
export interface ManagedSession {
  /** 会话唯一标识 (UUID) */
  sessionId: string;
  /** 账号所属用户组; null 表示历史/全局资源池 */
  groupId?: number | null;
  /** Apple ID 邮箱 */
  email: string;
  /** 密码 — 仅内存持有, 不持久化, 用于 re-login 刷新余额 */
  password: string;
  /** 会话当前状态 */
  status: 'awaiting_login' | 'awaiting_2fa' | 'logged_in' | 'expired';
  /** 登录时间戳 (ms) */
  loginTime: number;
  /** 绑定的 Decodo session tag — 同一 tag 在 24h 内对应同一出口 IP */
  proxySessionTag: string;
  /** 设备指纹 GUID (SHA1, 40 hex chars) */
  guid: string;
  /** 账号所属国家/地区 (如 'cn', 'jp', 'us') — 用于兑换时匹配卡的地区 */
  region: string;
  /** 登录成功后的账号数据, 未登录时为 null */
  account: SessionAccountData | null;
  /**
   * Apple session cookies — 由 MZFinance authenticate 响应 Set-Cookie 设置.
   * 关键 cookie: mz_at_ssl-{dsid}, mt-tkn-{dsid}, mz_at0_fr-{dsid}
   * 这些 cookies 是后续 commerce 端点 (redeemInfo, redeemCodeSrv, addFunds) 的认证凭据.
   */
  sessionCookies: Map<string, string>;
}

// ─── 登录结果 ─────────────────────────────────────────────────

/**
 * @description 登录结果 — 对标 Java LoginResult.
 *
 * 结构化返回,区分三种状态:
 * - success: 登录完成, 返回 sessionId + account
 * - needs_2fa: 需要 2FA 验证码, 返回 sessionId (复用同一 session 提交验证码)
 * - failed: 登录失败, 返回错误信息
 */
export interface LoginResultDto {
  status: 'success' | 'needs_2fa' | 'failed';
  sessionId?: string;
  account?: Omit<SessionAccountData, 'passwordToken' | 'clearToken'>;
  errorMessage?: string;
}

// ─── 会话序列化 (API 响应) ────────────────────────────────────

/**
 * @description 会话信息的 API 响应格式 — 对标 Java ManagedAccount.toMap().
 *
 * 不包含敏感 token 数据 (passwordToken, clearToken, password),
 * 只返回业务可见字段.
 */
export interface SessionInfoDto {
  sessionId: string;
  email: string;
  status: string;
  loginTime: number;
  proxySessionTag: string;
  /** 以下字段仅在已登录时有值 */
  name?: string;
  dsid?: string;
  storeFront?: string;
  creditBalance?: string | null;
  creditDisplay?: string | null;
  freeSongBalance?: string | null;
}
