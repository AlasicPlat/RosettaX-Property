/**
 * @file proxy-config.interface.ts
 * @description 代理配置通用接口 + 代理服务商抽象接口.
 *
 * 所有代理服务商 (Decodo, iProyal, ...) 的配置对象都实现 ProxyConfig 接口,
 * 所有代理服务商的 Service 都实现 ProxyProvider 接口.
 * 上层消费者 (HttpProxyService, SessionManagerService 等) 只依赖这两个接口.
 *
 * 新增服务商只需:
 * 1. 创建 xxx-proxy.service.ts 实现 ProxyProvider
 * 2. 在 ProxyModule 的 factory 中注册
 * 3. .env 中设置 PROXY_PROVIDER=xxx
 */

/**
 * @description 代理配置接口 — 代理服务商无关.
 *
 * 设计意图: 解耦代理服务商实现与上层消费者.
 * 无论底层使用 Decodo 还是 iProyal, 上层只看到统一的 ProxyConfig.
 */
export interface ProxyConfig {
  /** 代理协议 — socks5 / socks5h / https */
  protocol: string;
  /** 代理服务器域名 */
  host: string;
  /** 代理端口 */
  port: number;
  /** 认证用户名 */
  username: string;
  /** 认证密码 (可能含 session 后缀) */
  password: string;
  /**
   * Sticky session 标识 — 用于绑定出口 IP.
   * 随机 IP 模式下为空字符串, sticky 模式下为随机生成的标识.
   */
  sessionTag: string;
}

/**
 * @description 代理服务商抽象接口 — Strategy Pattern.
 *
 * 设计意图: 所有代理服务商 (iProyal, Decodo, 未来的新服务商) 必须实现此接口.
 * 消费者通过 @Inject(PROXY_PROVIDER) 获取实例, 无需关心底层是哪个服务商.
 *
 * 方法语义说明:
 * - acquireForAccount: 为指定账号获取 sticky session 代理 (同一账号复用同一出口 IP)
 * - acquireRandom: 获取随机 IP 代理 (每次请求不同出口 IP)
 * - getConfigForSessionTag: 根据已有 sessionTag 重建代理配置 (用于恢复持久化会话)
 * - releaseSession: 释放账号的 session 映射 (登出时调用)
 * - rotateSession: 轮换代理 session (故障时生成新 sessionTag, 获得新出口 IP)
 */
export interface ProxyProvider {
  /** 为指定账号获取 sticky session 代理 */
  acquireForAccount(email: string): Promise<ProxyConfig>;
  /** 获取随机 IP 代理 — 每次请求使用不同出口 IP */
  acquireRandom(): ProxyConfig;
  /** 根据已有 sessionTag 构建代理配置 */
  getConfigForSessionTag(sessionTag: string): ProxyConfig;
  /** 释放账号的 session 映射 */
  releaseSession(email: string): Promise<void>;
  /** 轮换代理 session — 故障时获得新出口 IP */
  rotateSession(email: string): Promise<ProxyConfig>;
}

/**
 * NestJS 注入 token — 消费者通过 @Inject(PROXY_PROVIDER) 获取 ProxyProvider 实例.
 *
 * ProxyModule 的 useFactory 会根据 PROXY_PROVIDER 环境变量
 * 动态绑定到 IProyalProxyService 或 DecodoProxyService.
 */
export const PROXY_PROVIDER = Symbol('PROXY_PROVIDER');
