import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ProxyConfig, ProxyProvider } from './proxy-config.interface';

/**
 * @file seekproxy.service.ts
 * @description SeekProxy 动态住宅代理服务.
 *
 * 设计意图:
 * SeekProxy 通过 /out-api/get-ips 接口按需提取代理。为了满足“每次请求都切换
 * 代理 IP”的业务约束, 本服务不会缓存提取结果, 每次 acquireRandom() 都会向
 * SeekProxy 重新提取 1 个代理。
 *
 * 接口文档:
 * GET https://www.seekproxy.com/out-api/get-ips
 * 必填参数: trade_no、key、auth_type、ip_count。
 */

/** SeekProxy API 默认地址 */
const DEFAULT_SEEKPROXY_API_URL = 'https://www.seekproxy.com/out-api/get-ips';
/** SeekProxy API 请求超时时间 */
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
/** 账号密码模式: 返回 host:port:username:password */
const AUTH_TYPE_ACCOUNT_PASSWORD = '1';
/** 白名单模式: 返回 ip:port */
const AUTH_TYPE_WHITELIST = '2';

/**
 * @description SeekProxy 提取 IP 接口响应结构.
 */
interface SeekProxyApiResponse {
  /** 返回码, 200 表示成功 */
  code: number;
  /** 返回消息 */
  msg: string;
  /** 代理字符串列表 */
  data?: string[];
}

@Injectable()
export class SeekProxyService implements ProxyProvider {
  private readonly logger = new Logger(SeekProxyService.name);

  /** SeekProxy 提取 IP API 地址 */
  private readonly apiUrl: string;
  /** 业务号 */
  private readonly tradeNo: string;
  /** 业务密钥 */
  private readonly apiKey: string;
  /** 提取模式: 1=账号密码模式, 2=白名单模式 */
  private readonly authType: string;
  /** 每次提取数量, 当前业务固定使用第一个返回项 */
  private readonly ipCount: number;
  /** 下游代理协议, 用于创建 Node Agent */
  private readonly proxyProtocol: string;
  /** SeekProxy 协议参数: 0=http, 2=socks5 */
  private readonly apiProtocolCode: string;
  /** 可选国家编码 */
  private readonly country: string;
  /** 可选州省编码 */
  private readonly state: string;
  /** 可选城市编码 */
  private readonly city: string;
  /** 可选返回格式参数, 仅 auth_type=1 生效 */
  private readonly pattern: string;
  /** 可选时效编码, 仅 auth_type=1 生效 */
  private readonly validCode: string;
  /** 可选 IP 时效分钟数, 仅 auth_type=2 生效 */
  private readonly time: string;

  constructor(private readonly configService: ConfigService) {
    this.apiUrl = this.configService.get<string>('SEEKPROXY_API_URL', DEFAULT_SEEKPROXY_API_URL);
    this.tradeNo = this.configService.get<string>('SEEKPROXY_TRADE_NO', '');
    this.apiKey = this.configService.get<string>('SEEKPROXY_KEY', '');
    this.authType = this.configService.get<string>('SEEKPROXY_AUTH_TYPE', AUTH_TYPE_ACCOUNT_PASSWORD);
    this.ipCount = this.readPositiveInteger('SEEKPROXY_IP_COUNT', 1);
    this.proxyProtocol = this.normalizeProxyProtocol(
      this.configService.get<string>('SEEKPROXY_PROXY_PROTOCOL', 'socks5'),
    );
    this.apiProtocolCode = this.configService.get<string>(
      'SEEKPROXY_PROTOCOL_CODE',
      this.proxyProtocol.startsWith('socks') ? '2' : '0',
    );
    this.country = this.configService.get<string>('SEEKPROXY_COUNTRY', '');
    this.state = this.configService.get<string>('SEEKPROXY_STATE', '');
    this.city = this.configService.get<string>('SEEKPROXY_CITY', '');
    this.pattern = this.configService.get<string>('SEEKPROXY_PATTERN', '');
    this.validCode = this.configService.get<string>('SEEKPROXY_VALID_CODE', '');
    this.time = this.configService.get<string>('SEEKPROXY_TIME', '');

    const isActiveProvider = this.configService.get<string>('PROXY_PROVIDER', 'iproyal') === 'seekproxy';
    if (!this.tradeNo || !this.apiKey) {
      if (!isActiveProvider) return;
      this.logger.error('SEEKPROXY_TRADE_NO 或 SEEKPROXY_KEY 未配置, 代理服务将无法正常工作');
    } else if (isActiveProvider) {
      this.logger.log(
        `✓ SeekProxy 代理已初始化: authType=${this.authType}, protocol=${this.proxyProtocol}, ipCount=${this.ipCount}`,
      );
    }
  }

  /**
   * @description 为指定账号获取代理.
   *
   * SeekProxy 当前按“每次请求切换 IP”运行, 因此账号参数仅用于保持 ProxyProvider
   * 接口一致, 不会建立 email 到代理 IP 的 sticky 绑定。
   *
   * @param email 账号邮箱, 不会发送给 SeekProxy
   * @returns 新提取的代理配置
   */
  async acquireForAccount(email: string): Promise<ProxyConfig> {
    this.logger.debug(`[acquireForAccount] 为账号提取新 SeekProxy IP: ${email.toLowerCase()}`);
    return this.fetchFreshProxy();
  }

  /**
   * @description 获取随机代理.
   *
   * 每次调用都会请求 SeekProxy 提取接口, 不使用内存缓存或 Agent 缓存,
   * 以满足“每次请求都切换代理 IP”的约束。
   *
   * @returns 新提取的代理配置
   */
  async acquireRandom(): Promise<ProxyConfig> {
    return this.fetchFreshProxy();
  }

  /**
   * @description 根据既有 sessionTag 获取代理配置.
   *
   * SeekProxy 模式下 sessionTag 不代表可恢复的供应商会话。为了避免复用旧 IP,
   * 这里始终重新提取代理。
   *
   * @param sessionTag 历史 session 标识, 当前实现不会复用
   * @returns 新提取的代理配置
   */
  async getConfigForSessionTag(sessionTag: string): Promise<ProxyConfig> {
    if (sessionTag) {
      this.logger.debug(`[getConfigForSessionTag] 忽略历史 sessionTag 并提取新 IP: ${sessionTag}`);
    }
    return this.fetchFreshProxy();
  }

  /**
   * @description 释放账号代理映射.
   *
   * SeekProxy 不维护本地 sticky 映射, 因此该方法是幂等 no-op。
   *
   * @param email 账号邮箱
   */
  async releaseSession(email: string): Promise<void> {
    this.logger.debug(`[releaseSession] SeekProxy 无需释放本地代理映射: ${email.toLowerCase()}`);
  }

  /**
   * @description 轮换账号代理.
   *
   * SeekProxy 的轮换语义就是重新提取一个代理。
   *
   * @param email 账号邮箱, 不会发送给 SeekProxy
   * @returns 新提取的代理配置
   */
  async rotateSession(email: string): Promise<ProxyConfig> {
    this.logger.debug(`[rotateSession] 为账号重新提取 SeekProxy IP: ${email.toLowerCase()}`);
    return this.fetchFreshProxy();
  }

  /**
   * @description 从 SeekProxy 提取一个新的代理并转换为统一 ProxyConfig.
   *
   * @returns 新提取的代理配置
   * @throws Error 当配置缺失、接口失败或返回数据无法解析时抛出
   */
  private async fetchFreshProxy(): Promise<ProxyConfig> {
    this.assertConfigured();

    try {
      const response = await axios.get<SeekProxyApiResponse>(this.apiUrl, {
        params: this.buildRequestParams(),
        proxy: false,
        timeout: DEFAULT_REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });

      const payload = response.data;
      if (response.status !== 200 || payload?.code !== 200) {
        throw new Error(
          `SeekProxy 提取失败: httpStatus=${response.status}, code=${payload?.code ?? 'unknown'}, msg=${payload?.msg ?? 'empty'}`,
        );
      }

      const proxyLine = payload.data?.[0]?.trim();
      if (!proxyLine) {
        throw new Error('SeekProxy 提取失败: data 为空');
      }

      return this.parseProxyLine(proxyLine);
    } catch (error: any) {
      this.logger.error(`SeekProxy 提取代理失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * @description 构造 SeekProxy 提取 IP 接口参数.
   *
   * @returns Query 参数对象
   */
  private buildRequestParams(): Record<string, string> {
    const params: Record<string, string> = {
      trade_no: this.tradeNo,
      key: this.apiKey,
      auth_type: this.authType,
      ip_count: String(this.ipCount),
    };

    this.assignIfPresent(params, 'country', this.country);
    this.assignIfPresent(params, 'state', this.state);
    this.assignIfPresent(params, 'city', this.city);

    if (this.authType === AUTH_TYPE_ACCOUNT_PASSWORD) {
      this.assignIfPresent(params, 'protocol', this.apiProtocolCode);
      this.assignIfPresent(params, 'pattern', this.pattern);
      this.assignIfPresent(params, 'valid_code', this.validCode);
    }

    if (this.authType === AUTH_TYPE_WHITELIST) {
      this.assignIfPresent(params, 'time', this.time);
    }

    return params;
  }

  /**
   * @description 解析 SeekProxy 返回的代理字符串.
   *
   * 支持两种格式:
   * - auth_type=1: host:port:username:password
   * - auth_type=2: host:port
   *
   * @param proxyLine SeekProxy 返回的单条代理字符串
   * @returns 统一代理配置
   * @throws Error 当代理格式或端口无效时抛出
   */
  private parseProxyLine(proxyLine: string): ProxyConfig {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(proxyLine)) {
      return this.parseProxyUrl(proxyLine);
    }

    const [host, portText, username = '', ...passwordParts] = proxyLine.split(':');
    const port = Number(portText);

    if (!host || !Number.isInteger(port) || port <= 0) {
      throw new Error(`SeekProxy 返回的代理格式无效: ${this.maskProxyLine(proxyLine)}`);
    }

    return {
      protocol: this.proxyProtocol,
      host,
      port,
      username,
      password: passwordParts.join(':'),
      sessionTag: '',
    };
  }

  /**
   * @description 解析带 scheme 的代理 URL.
   *
   * @param proxyUrl 代理 URL
   * @returns 统一代理配置
   * @throws Error 当 URL 无效时抛出
   */
  private parseProxyUrl(proxyUrl: string): ProxyConfig {
    try {
      const url = new URL(proxyUrl);
      const port = Number(url.port);
      if (!url.hostname || !Number.isInteger(port) || port <= 0) {
        throw new Error('hostname 或 port 无效');
      }

      return {
        protocol: this.normalizeProxyProtocol(url.protocol.replace(':', '')),
        host: url.hostname,
        port,
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        sessionTag: '',
      };
    } catch (error: any) {
      throw new Error(`SeekProxy 返回的代理 URL 无效: ${this.maskProxyLine(proxyUrl)}, reason=${error.message}`);
    }
  }

  /**
   * @description 校验必填配置.
   * @throws Error 当业务号或密钥为空时抛出
   */
  private assertConfigured(): void {
    if (!this.tradeNo || !this.apiKey) {
      throw new Error('SeekProxy 未配置 SEEKPROXY_TRADE_NO 或 SEEKPROXY_KEY');
    }
  }

  /**
   * @description 读取正整数配置.
   *
   * @param key 配置键
   * @param fallback 默认值
   * @returns 正整数配置值
   */
  private readPositiveInteger(key: string, fallback: number): number {
    const value = Number(this.configService.get<string>(key, String(fallback)));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  /**
   * @description 标准化代理协议字符串.
   *
   * @param protocol 原始协议配置
   * @returns 小写且不带冒号的协议
   */
  private normalizeProxyProtocol(protocol: string): string {
    const normalized = protocol.trim().toLowerCase().replace(/:$/, '');
    return normalized || 'socks5';
  }

  /**
   * @description 有值时写入请求参数.
   *
   * @param params 参数对象
   * @param key 参数键
   * @param value 参数值
   * @sideEffects 当 value 非空时修改 params
   */
  private assignIfPresent(params: Record<string, string>, key: string, value: string): void {
    if (value) {
      params[key] = value;
    }
  }

  /**
   * @description 脱敏代理字符串, 避免日志输出代理账号密码.
   *
   * @param proxyLine 原始代理字符串
   * @returns 脱敏后的代理字符串
   */
  private maskProxyLine(proxyLine: string): string {
    const parts = proxyLine.split(':');
    if (parts.length <= 2) return proxyLine;
    return `${parts[0]}:${parts[1]}:***`;
  }
}
