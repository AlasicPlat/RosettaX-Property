import { Injectable, Logger, Inject } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyConfig, ProxyProvider, PROXY_PROVIDER } from '../proxy/proxy-config.interface';
import { CookieContainer } from './cookie-jar.service';
import { buildInterfaceResponseLog } from '../../utils/interface-response-log.util';

/**
 * @description 代理请求配置 — 控制代理使用行为
 */
export interface ProxyRequestConfig extends AxiosRequestConfig {
  /** 是否使用代理 (默认 true) */
  useProxy?: boolean;
  /** 最大重试次数 — 代理故障时自动切换 (默认 2 次) */
  maxRetries?: number;
  /** 接口诊断日志标签; 仅调用方显式传入时输出响应状态、关键 header 和 Set-Cookie 摘要 */
  interfaceLogLabel?: string;
}

/**
 * @description HTTP 代理服务 — 集成 SOCKS5/HTTPS 代理, 自动故障重试.
 *
 * 核心能力:
 * 1. 接收 ProxyConfig 构建对应的 httpAgent / httpsAgent
 * 2. 支持 SOCKS5 (SocksProxyAgent via socks-proxy-agent) 和 HTTPS (HttpsProxyAgent via https-proxy-agent) 两种代理协议
 * 3. 请求失败时由上层决定是否 rotateSession() 切换代理
 * 4. 支持无代理直连模式 (useProxy: false)
 * 5. requestWithCookies(): 手动跟随重定向, 逐跳收集 cookies — 解决 axios 重定向丢 cookie 问题
 *
 * 20260423 重构说明:
 * - 代理服务商从 Decodo 切换到 iProyal (连接更稳定)
 * - 代理配置由调用方传入 ProxyConfig (从 IProyalProxyService 获取)
 * - 代理状态完全内存化, 零 DB 依赖
 */
/** Agent 缓存条目 */
interface CachedAgent {
  agent: any;
  createdAt: number;
}

/** Agent 缓存 TTL — 与 session TTL 对齐 (10 分钟) */
const AGENT_CACHE_TTL_MS = 10 * 60 * 1000;
/** Agent 缓存清理间隔 (2 分钟) */
const AGENT_CLEANUP_INTERVAL_MS = 2 * 60 * 1000;

@Injectable()
export class HttpProxyService {
  private readonly logger = new Logger(HttpProxyService.name);

  /**
   * Per-sessionTag Agent 缓存 — 复用 SOCKS5+TLS 连接, 省去重复握手开销 (~1-1.5s).
   *
   * Key: sessionTag (空字符串 = 随机 IP, 不缓存)
   * Value: { agent, createdAt }
   *
   * 同一个 sessionTag 对应同一个 Decodo 出口 IP (24h 内),
   * 复用 Agent 仅复用 TCP/TLS 连接, 不影响 IP 分配逻辑.
   */
  private readonly agentCache = new Map<string, CachedAgent>();
  private agentCleanupTimer: NodeJS.Timeout | null = null;

  constructor(@Inject(PROXY_PROVIDER) private readonly proxyService: ProxyProvider) {
    // 定时清理过期 Agent
    this.agentCleanupTimer = setInterval(() => {
      this.pruneExpiredAgents();
    }, AGENT_CLEANUP_INTERVAL_MS);
  }

  // ==================== 代理获取 ====================

  /**
   * @description 获取一个随机 IP 代理配置 — 用于无需 sticky session 的场景.
   *
   * 替代原 acquireProxy() 的 "随机选取" 语义.
   * 返回 Decodo 随机 IP 配置 (每次请求不同 IP).
   *
   * @returns 随机 IP 的代理配置 (非 null, Decodo 网关保证可用)
   */
  acquireRandomProxy(): ProxyConfig {
    return this.proxyService.acquireRandom();
  }

  /**
   * @description 获取指定账号的 sticky session 代理 — 同一账号复用同一出口 IP.
   *
   * 这是替代原 acquireProxy() 的主要方法, 增加了 email 参数绑定.
   *
   * @param email 账号邮箱
   * @returns 绑定该账号的代理配置
   */
  async acquireProxyForAccount(email: string): Promise<ProxyConfig> {
    return this.proxyService.acquireForAccount(email);
  }

  /**
   * @description 代理故障时轮换 session — 生成新的出口 IP.
   *
   * 替代原 deactivate() + getRandomActive() 的两步操作.
   *
   * @param email 账号邮箱
   * @returns 新的代理配置
   */
  async rotateProxyForAccount(email: string): Promise<ProxyConfig> {
    return this.proxyService.rotateSession(email);
  }

  // ==================== 基础请求 ====================

  /**
   * @description 发送 HTTP 请求 — 自动附加代理 Agent.
   *
   * 工作流程:
   * 1. 检查是否需要代理 (useProxy 参数)
   * 2. 使用 Decodo 随机 IP 代理, 构建 Agent 附加到 axios config
   * 3. 发送请求, 失败则自动重试 (每次获取新随机 IP)
   *
   * @param config 请求配置 (继承 AxiosRequestConfig, 扩展代理参数)
   * @returns Axios 响应对象
   * @throws Error 所有重试均失败时抛出最后一次的错误
   */
  async request<T = any>(config: ProxyRequestConfig): Promise<AxiosResponse<T>> {
    const { useProxy = true, maxRetries = 2, interfaceLogLabel: _interfaceLogLabel, ...axiosConfig } = config;

    // 无代理直连模式
    if (!useProxy) {
      return axios({
        ...axiosConfig,
        proxy: false, // 禁止 axios 读取环境变量代理, 保证直连语义
        timeout: axiosConfig.timeout || 30000,
      });
    }

    let lastError: Error | null = null;

    // 重试循环: 每次使用新的随机 IP
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // 每次重试使用新的随机 IP (Decodo 基础用户名模式)
        const proxyConfig = this.acquireRandomProxy();

        const agent = this.createAgent(
          proxyConfig.protocol,
          proxyConfig.host,
          proxyConfig.port,
          proxyConfig.username,
          proxyConfig.password,
        );

        const requestConfig: AxiosRequestConfig = {
          ...axiosConfig,
          httpAgent: agent,
          httpsAgent: agent,
          proxy: false, // 关键: 避免 axios 再走 HTTP(S)_PROXY 导致双重代理
          timeout: axiosConfig.timeout || 30000,
        };

        return await axios(requestConfig);
      } catch (error: any) {
        lastError = error;

        const isNetworkError = !error.response;
        if (isNetworkError && attempt < maxRetries) {
          this.logger.warn(
            `请求失败 (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}, 重试...`,
          );
        }
      }
    }

    throw lastError;
  }

  // ==================== Sticky Session 请求 ====================

  /**
   * @description 使用指定代理发送 HTTP 请求 — sticky session 场景下锁定同一代理节点.
   *
   * 与 request() 的区别: 不随机选取, 而是使用调用方传入的代理配置.
   * 代理故障时不自动切换 (由调用方通过 rotateProxyForAccount() 获取新代理后重试).
   *
   * @param config 请求配置
   * @param proxy 指定的代理配置 (null 表示直连)
   * @returns Axios 响应对象
   * @throws Error 请求失败时抛出错误, 调用方可据此决定是否切换代理
   */
  async requestWithProxy<T = any>(
    config: ProxyRequestConfig,
    proxy: ProxyConfig | null,
  ): Promise<AxiosResponse<T>> {
    const { useProxy = true, maxRetries = 2, interfaceLogLabel: _interfaceLogLabel, ...axiosConfig } = config;

    // 无代理或直连模式
    if (!useProxy || !proxy) {
      return axios({
        ...axiosConfig,
        proxy: false,
        timeout: axiosConfig.timeout || 30000,
      });
    }

    let lastError: Error | null = null;

    // sticky session 场景下同一代理也允许网络层错误重试
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const agent = this.getOrCreateAgent(proxy);

        const requestConfig: AxiosRequestConfig = {
          ...axiosConfig,
          httpAgent: agent,
          httpsAgent: agent,
          proxy: false,
          timeout: axiosConfig.timeout || 30000,
        };

        const response = await axios(requestConfig);
        return response;
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response;
        if (isNetworkError && this.isProxyTransportError(error)) {
          // 代理传输层故障 — 不再在同一 session tag 上重试, 交由上层 rotateSession
          this.logger.warn(
            `[stickyProxy ${proxy.sessionTag || 'random'}] 判定为代理传输层故障, 停止重试, 交由上层切换代理`,
          );
          break;
        }
        if (isNetworkError && attempt < maxRetries) {
          this.logger.warn(
            `[stickyProxy ${proxy.sessionTag || 'random'}] 请求失败 (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}, 重试相同代理...`,
          );
        }
      }
    }

    throw lastError;
  }

  // ==================== 手动重定向 + Cookie 收集 ====================

  /**
   * @description 手动跟随重定向的请求 — 每一跳收集 Set-Cookie, 解决 axios 重定向丢 cookie 问题.
   *
   * 对标 C++ V2 Init() L2182-2266 的三步手动重定向逻辑:
   * 1. 禁止 axios 自动重定向 (maxRedirects: 0)
   * 2. 循环读取 Location header, 逐跳发起 GET
   * 3. 每跳合并 Set-Cookie 到 CookieContainer
   * 4. 用更新后的 cookies 发起下一跳
   * 5. 返回最终非 3xx 的响应
   *
   * @param config 请求配置 (Cookie header 会被内部管理, 不需要调用方设置)
   * @param cookies CookieContainer 实例, 逐跳合并 Set-Cookie
   * @param proxy 指定代理配置 (sticky session), null 表示直连
   * @param maxHops 最大重定向跳数 (防死循环, 默认 10)
   * @returns 最终非 3xx 响应
   */
  async requestWithCookies<T = any>(
    config: ProxyRequestConfig,
    cookies: CookieContainer,
    proxy: ProxyConfig | null,
    maxHops: number = 10,
  ): Promise<AxiosResponse<T>> {
    const { useProxy = true, maxRetries = 2, interfaceLogLabel, ...axiosConfig } = config;

    let currentUrl = axiosConfig.url!;
    let currentMethod = (axiosConfig.method || 'GET').toUpperCase();
    let response: AxiosResponse<T>;

    for (let hop = 0; hop < maxHops; hop++) {
      const requestCookieCount = cookies.size;

      // 每跳请求: 禁止自动重定向, 使用最新的 cookie 字符串
      const hopConfig: AxiosRequestConfig = {
        ...axiosConfig,
        url: currentUrl,
        method: currentMethod,
        maxRedirects: 0,
        validateStatus: () => true, // 接受所有状态码, 手动处理 3xx
        headers: {
          ...(axiosConfig.headers || {}),
          'Cookie': cookies.toRequestString(),
        },
        proxy: false,
        timeout: axiosConfig.timeout || 30000,
      };

      // 附加代理 Agent — 复用缓存的 Agent 以省去 SOCKS5+TLS 握手
      if (useProxy && proxy) {
        const agent = this.getOrCreateAgent(proxy);
        hopConfig.httpAgent = agent;
        hopConfig.httpsAgent = agent;
      }

      response = await axios(hopConfig);

      // 每跳收集 Set-Cookie — 这是与直接 axios.request() 的关键区别
      cookies.mergeFromSetCookieHeaders(response.headers['set-cookie']);
      cookies.removeEmptyCookies();

      if (interfaceLogLabel) {
        this.logger.log(buildInterfaceResponseLog(
          `${interfaceLogLabel}.hop${hop + 1}`,
          response,
          undefined,
          {
            method: currentMethod,
            url: currentUrl,
            requestCookieCount,
            accumulatedCookieCount: cookies.size,
          },
        ));
      }

      // 非 3xx 重定向, 返回最终响应
      if (response.status < 300 || response.status >= 400) {
        return response;
      }

      // 读取 Location header, 准备下一跳
      const location = response.headers['location'];
      if (!location) {
        // 3xx 但没有 Location, 直接返回
        this.logger.warn(`[requestWithCookies] 收到 ${response.status} 但无 Location header`);
        return response;
      }

      // 拼接绝对 URL — Location 可能是相对路径
      if (location.startsWith('http')) {
        currentUrl = location;
      } else {
        const urlObj = new URL(location, currentUrl);
        currentUrl = urlObj.toString();
      }

      // 重定向后强制为 GET (HTTP 规范: 302/303 应改为 GET, 307/308 保持原方法)
      if (response.status === 302 || response.status === 303 || response.status === 301) {
        currentMethod = 'GET';
      }

      // this.logger.debug(`[requestWithCookies] 重定向 hop ${hop + 1} → ${currentUrl} (${response.status})`);
    }

    // 超过最大跳数, 返回最后一个响应
    this.logger.warn(`[requestWithCookies] 超过最大重定向跳数 ${maxHops}`);
    return response!;
  }

  // ==================== 私有方法 ====================

  /**
   * @description 获取或创建代理 Agent — sticky session 场景下复用缓存的 Agent.
   *
   * 缓存策略:
   * - sessionTag 非空 (sticky session): 按 sessionTag 缓存, TTL 10 分钟
   * - sessionTag 为空 (随机 IP): 不缓存, 每次创建新 Agent
   *
   * 复用 Agent 的好处:
   * - 省去 SOCKS5 握手 (~500-800ms) + TLS 握手 (~500-800ms)
   * - 利用 HTTP Keep-Alive 复用已建立的 TCP 连接
   * - 预计每次请求节省 ~1-1.5s
   *
   * @param proxy Decodo 代理配置
   * @returns Agent 实例 (可能是缓存的)
   */
  private getOrCreateAgent(proxy: ProxyConfig): any {
    // 随机 IP 模式不缓存 — 每次需要不同 IP
    if (!proxy.sessionTag) {
      return this.createAgent(proxy.protocol, proxy.host, proxy.port, proxy.username, proxy.password);
    }

    const cached = this.agentCache.get(proxy.sessionTag);
    if (cached && Date.now() - cached.createdAt < AGENT_CACHE_TTL_MS) {
      return cached.agent;
    }

    // 创建新 Agent 并缓存
    const agent = this.createAgent(proxy.protocol, proxy.host, proxy.port, proxy.username, proxy.password);
    this.agentCache.set(proxy.sessionTag, { agent, createdAt: Date.now() });
    // this.logger.debug(`[AgentCache] 新建并缓存 Agent: sessionTag=${proxy.sessionTag}, cacheSize=${this.agentCache.size}`);
    return agent;
  }

  /**
   * @description 根据协议类型创建对应的代理 Agent 实例.
   *
   * keepAlive: true — 复用 TCP 连接, 避免重复 TCP/TLS 握手.
   * 配合 agentCache 使用, 同一 sessionTag 的后续请求直接复用已建立的连接.
   */
  private createAgent(
    protocol: string,
    host: string,
    port: number,
    username: string,
    password: string,
  ): any {
    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    const proxyUrl = `${protocol}://${auth}${host}:${port}`;

    if (protocol.startsWith('socks')) {
      return new SocksProxyAgent(proxyUrl, { timeout: 15000, keepAlive: true });
    }

    return new HttpsProxyAgent(proxyUrl, { timeout: 15000, keepAlive: true });
  }

  /**
   * @description 清理过期的 Agent 缓存条目, 释放底层 TCP 连接.
   */
  private pruneExpiredAgents(): void {
    const now = Date.now();
    let pruned = 0;
    for (const [tag, cached] of this.agentCache.entries()) {
      if (now - cached.createdAt >= AGENT_CACHE_TTL_MS) {
        try { cached.agent.destroy?.(); } catch { /* ignore */ }
        this.agentCache.delete(tag);
        pruned++;
      }
    }
    if (pruned > 0) {
      this.logger.debug(`[AgentCache] 清理过期 Agent: pruned=${pruned}, remaining=${this.agentCache.size}`);
    }
  }

  /**
   * @description 主动淘汰指定 sessionTag 的 Agent — 代理故障时由上层调用.
   * @param sessionTag 要淘汰的 session 标识
   */
  evictAgent(sessionTag: string): void {
    const cached = this.agentCache.get(sessionTag);
    if (cached) {
      try { cached.agent.destroy?.(); } catch { /* ignore */ }
      this.agentCache.delete(sessionTag);
      this.logger.debug(`[AgentCache] 主动淘汰 Agent: sessionTag=${sessionTag}`);
    }
  }

  /**
   * @description 是否为代理传输层错误 (而非目标站业务错误).
   */
  private isProxyTransportError(error: any): boolean {
    const message = String(error?.message || '');
    // SOCKS5 层面的错误 (认证失败、连接拒绝等)
    if (message.includes('Socks5') || message.startsWith('SOCKS5') || message.startsWith('HTTP CONNECT')) {
      return true;
    }

    const code = String(error?.code || '');
    return ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
  }
}
