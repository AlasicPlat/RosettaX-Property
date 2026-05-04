import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 * 20260502 重构说明:
 * - 代理服务商切换到 SeekProxy
 * - 随机代理获取改为异步提取, 每次 acquireRandomProxy() 都请求供应商获取新 IP
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
/** 默认出口 IP 查询接口 */
const DEFAULT_EXIT_IP_CHECK_URL = 'https://api.ipify.org?format=json';
/** 默认出口 IP 查询超时 */
const DEFAULT_EXIT_IP_CHECK_TIMEOUT_MS = 5000;

@Injectable()
export class HttpProxyService {
  private readonly logger = new Logger(HttpProxyService.name);
  /** 是否开启出口 IP 日志; 开启后每次代理请求前会额外发起一次 IP 查询请求 */
  private readonly exitIpLogEnabled: boolean;
  /** 出口 IP 查询接口, 必须返回 JSON { ip } 或纯文本 IP */
  private readonly exitIpCheckUrl: string;
  /** 出口 IP 查询超时时间 */
  private readonly exitIpCheckTimeoutMs: number;

  /**
   * Per-sessionTag Agent 缓存 — 复用 SOCKS5+TLS 连接, 省去重复握手开销 (~1-1.5s).
   *
   * Key: sessionTag (空字符串 = 随机 IP, 不缓存)
   * Value: { agent, createdAt }
   *
   * 同一个 sessionTag 对应同一个供应商 sticky 出口 IP,
   * 复用 Agent 仅复用 TCP/TLS 连接, 不影响 IP 分配逻辑.
   */
  private readonly agentCache = new Map<string, CachedAgent>();
  private agentCleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PROXY_PROVIDER) private readonly proxyService: ProxyProvider,
    private readonly configService: ConfigService,
  ) {
    this.exitIpLogEnabled = this.readBooleanConfig('PROXY_EXIT_IP_LOG_ENABLED', false);
    this.exitIpCheckUrl = this.configService.get<string>('PROXY_EXIT_IP_CHECK_URL', DEFAULT_EXIT_IP_CHECK_URL);
    this.exitIpCheckTimeoutMs = this.readPositiveIntegerConfig(
      'PROXY_EXIT_IP_CHECK_TIMEOUT_MS',
      DEFAULT_EXIT_IP_CHECK_TIMEOUT_MS,
    );

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
   * 返回供应商随机 IP 配置 (每次请求不同 IP).
   *
   * @returns 随机 IP 的代理配置
   */
  async acquireRandomProxy(): Promise<ProxyConfig> {
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
   * 2. 使用供应商随机 IP 代理, 构建 Agent 附加到 axios config
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
        // 每次重试都重新向供应商提取代理, 保证切换出口 IP
        const proxyConfig = await this.acquireRandomProxy();

        const agent = this.createAgent(
          proxyConfig.protocol,
          proxyConfig.host,
          proxyConfig.port,
          proxyConfig.username,
          proxyConfig.password,
        );
        await this.logExitIpIfEnabled(proxyConfig, agent, 'request', attempt + 1, axiosConfig.url);

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
        await this.logExitIpIfEnabled(proxy, agent, 'requestWithProxy', attempt + 1, axiosConfig.url);

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
    let proxyAgent: any | null = null;

    if (useProxy && proxy) {
      proxyAgent = this.getOrCreateAgent(proxy);
      await this.logExitIpIfEnabled(proxy, proxyAgent, 'requestWithCookies', 1, currentUrl);
    }

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
      if (proxyAgent) {
        hopConfig.httpAgent = proxyAgent;
        hopConfig.httpsAgent = proxyAgent;
      }

      response = await axios(hopConfig);

      // 每跳收集 Set-Cookie — 这是与直接 axios.request() 的关键区别
      cookies.mergeFromSetCookieHeaders(response.headers['set-cookie']);
      cookies.removeEmptyCookies();

      // if (interfaceLogLabel) {
      //   this.logger.log(buildInterfaceResponseLog(
      //     `${interfaceLogLabel}.hop${hop + 1}`,
      //     response,
      //     undefined,
      //     {
      //       method: currentMethod,
      //       url: currentUrl,
      //       requestCookieCount,
      //       accumulatedCookieCount: cookies.size,
      //     },
      //   ));
      // }

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
   * @param proxy 代理配置
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
   * @description 按配置记录真实出口 IP.
   *
   * 通过传入的同一个代理 Agent 请求出口 IP 查询接口, 用于确认当前代理链路的
   * 公网出口。查询失败只记录 warn, 不影响业务请求。
   *
   * @param proxy 当前业务请求使用的代理配置
   * @param agent 当前业务请求使用的代理 Agent
   * @param scope 调用场景
   * @param attempt 当前请求尝试次数
   * @param targetUrl 业务请求目标 URL, 仅用于日志定位
   * @sideEffects 可能发起一次额外 HTTP 请求并写日志
   */
  private async logExitIpIfEnabled(
    proxy: ProxyConfig,
    agent: any,
    scope: string,
    attempt: number,
    targetUrl?: string,
  ): Promise<void> {
    if (!this.exitIpLogEnabled) return;

    try {
      const response = await axios.get(this.exitIpCheckUrl, {
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
        timeout: this.exitIpCheckTimeoutMs,
        validateStatus: () => true,
      });
      const exitIp = this.extractExitIp(response.data);
      const targetHost = this.extractHostForLog(targetUrl);

      this.logger.log(
        `[ExitIP] scope=${scope}, attempt=${attempt}, exitIp=${exitIp || 'unknown'}, target=${targetHost}, proxy=${this.maskProxyForLog(proxy)}, status=${response.status}`,
      );
    } catch (error: any) {
      this.logger.warn(
        `[ExitIP] 查询失败: scope=${scope}, attempt=${attempt}, proxy=${this.maskProxyForLog(proxy)}, error=${error.message}`,
      );
    }
  }

  /**
   * @description 从出口 IP 查询接口响应中提取 IP.
   *
   * @param payload 响应体, 支持 { ip } JSON 或纯文本
   * @returns 提取到的 IP, 失败返回空字符串
   */
  private extractExitIp(payload: any): string {
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();
    if (typeof payload.ip === 'string') return payload.ip.trim();
    return '';
  }

  /**
   * @description 读取布尔配置.
   *
   * @param key 配置键
   * @param fallback 默认值
   * @returns 解析后的布尔值
   */
  private readBooleanConfig(key: string, fallback: boolean): boolean {
    const value = this.configService.get<string>(key);
    if (value === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }

  /**
   * @description 读取正整数配置.
   *
   * @param key 配置键
   * @param fallback 默认值
   * @returns 正整数配置值
   */
  private readPositiveIntegerConfig(key: string, fallback: number): number {
    const value = Number(this.configService.get<string>(key, String(fallback)));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  /**
   * @description 提取日志可用的目标 host, 避免输出完整 URL 泄露业务参数.
   *
   * @param targetUrl 请求 URL
   * @returns host 或 unknown
   */
  private extractHostForLog(targetUrl?: string): string {
    if (!targetUrl) return 'unknown';
    try {
      return new URL(targetUrl).host;
    } catch {
      return 'unknown';
    }
  }

  /**
   * @description 脱敏代理标识, 避免日志输出代理密码和完整账号.
   *
   * @param proxy 代理配置
   * @returns 可安全记录的代理标识
   */
  private maskProxyForLog(proxy: ProxyConfig): string {
    const username = proxy.username ? this.maskCredential(proxy.username) : 'none';
    return `${proxy.protocol}://${username}:***@${proxy.host}:${proxy.port},tag=${proxy.sessionTag || 'random'}`;
  }

  /**
   * @description 脱敏凭证字符串.
   *
   * @param value 原始凭证
   * @returns 脱敏凭证
   */
  private maskCredential(value: string): string {
    if (value.length <= 6) return '***';
    return `${value.slice(0, 3)}***${value.slice(-3)}`;
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
   *
   * 代理库部分超时只写入 message, 不一定填充 Node error.code。
   * 这里按 message 补齐识别, 避免在同一个坏 sticky 出口上重复等待。
   */
  private isProxyTransportError(error: any): boolean {
    const message = String(error?.message || '');
    // SOCKS5 层面的错误 (认证失败、连接拒绝等)
    const normalizedMessage = message.toLowerCase();
    if (
      message.includes('Socks5') ||
      message.startsWith('SOCKS5') ||
      message.startsWith('HTTP CONNECT') ||
      normalizedMessage.includes('proxy connection timed out') ||
      normalizedMessage.includes('socket hang up') ||
      normalizedMessage.includes('connection refused') ||
      normalizedMessage.includes('host unreachable') ||
      normalizedMessage.includes('network unreachable') ||
      normalizedMessage.includes('timed out')
    ) {
      return true;
    }

    const code = String(error?.code || '');
    return ['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
  }
}
