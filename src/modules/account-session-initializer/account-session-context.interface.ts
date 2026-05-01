/**
 * @file account-session-context.interface.ts
 * @description Apple Store 查询上下文接口定义.
 *
 * Reference: iTunesAPIs.h L64-95 — RESULT / ACCOUNT_INFO / DATA_CONTEXT / PROXY
 */

/**
 * @description 查询账号信息 — 对应 C++ ACCOUNT_INFO 结构体.
 *
 * 每个账号记录其登录状态和可用性, 登录成功后缓存的 cookies 用于后续请求.
 * 当登录失败时标记 available=false, 避免后续循环重复尝试.
 */
export interface AccountInfo {
  /** Apple ID 账号 (邮箱) */
  acc: string;
  /** 账号密码 */
  pwd: string;
  /** 账号是否可用 — 登录失败时标记为 false, 缓存阶段跳过不可用账号 */
  available: boolean;
  /** 账号是否已登录 — 区分"从未尝试"和"尝试过但失败" */
  isLogin: boolean;
  /** 登录成功后缓存的 cookies — 后续请求使用 */
  loginCookies: Map<string, string>;
}

/**
 * @description Apple Store 查询上下文 — 对应 C++ DATA_CONTEXT 结构体.
 *
 * 在整个查询生命周期内保持状态, 包括:
 * - 当前使用的账号索引和账号池
 * - Apple Store 的签名 token (x-aos-stk, x-as-actk)
 * - 查询 URL (从 init_data 中提取)
 * - Cookie 容器 (跨步骤共享)
 * - 风控状态标志
 */
export interface AccountSessionContext {
  /** 当前使用的账号索引 — 在账号池中的位置 */
  currentAccountIndex: number;
  /** 账号列表 — 支持多账号轮换 */
  accountInfoList: AccountInfo[];
  /** Apple Store 防重放令牌 — 从 init_data 的 meta.h 中提取 */
  x_aos_stk: string;
  /** Apple Store 会话令牌 — 从登录完成页的 init_data 中提取 */
  x_as_actk: string;
  /** 算法服务器地址 — 迁移后不再使用 (直接本地调用), 保留用于兼容性 */
  server: string;
  /** 国家/地区 URL 路径 (如 "/us", "/cn", "/jp") — 决定查询哪个区域的商店 */
  countryURL: string;
  /** 余额查询 API URL — 从 init_data 的 giftCardBalanceCheck 中提取 */
  queryURL: string;
  /** 内部返回码 — 记录最后一次错误状态 */
  internalReturnCode: number;
  /** 是否被风控 (HTTP 541) — 触发后需要切换账号或更换 IP */
  beRiskCtrl: boolean;
  /** 是否达到最大查询尝试次数 — 需要重新初始化上下文 */
  maxAttemptReached: boolean;
}

/**
 * @description 查询结果 — 对应 C++ RESULT 结构体.
 *
 * 每个业务方法都返回此结构, 调用方根据 code 判断后续行为.
 */
export interface QueryResult {
  /** 错误码 (0=成功, 其他见各方法说明) */
  code: number;
  /** 请求步骤位置 — 用于排查是在哪一步出错 */
  pos: number;
  /** 错误消息 — 人类可读的错误描述 */
  errMsg: string;
  /** 最后一次出错的 HTTP 响应码 (-1 表示未发生网络请求) */
  responseCode: number;
}
