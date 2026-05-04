import { Injectable, Logger } from '@nestjs/common';
import { CookieContainer, CookieJarService } from '../http-proxy';
import { DistributedCacheService, SerializedSession } from '../distributed-cache';
import { AccountSessionContext } from '../account-session-initializer/account-session-context.interface';

/** 无明确 Cookie 过期时间时的兜底 TTL (毫秒) */
const DEFAULT_SESSION_CACHE_FALLBACK_TTL_MS = 8 * 60 * 1000;
/** 根据接口过期时间计算 TTL 时预留的安全余量 (毫秒) */
const DEFAULT_SESSION_CACHE_TTL_SAFETY_MARGIN_MS = 60 * 1000;
/** 查询 session 最大 TTL 上限 (毫秒), 防止异常长 Cookie 让上下文长期复用 */
const DEFAULT_SESSION_CACHE_MAX_TTL_MS = 2 * 60 * 60 * 1000;
/** 单账号单区域查询次数上限 — 达到后清除上下文 + 冷却锁 */
const ROTATION_QUERY_THRESHOLD = 5;
/** 查询次数统计的时间窗口 (毫秒) — 1 分钟 */
const ROTATION_WINDOW_MS = 60 * 1000;
/** 账号冷却锁 TTL (秒) — 冷却期间不可初始化或查询 */
const COOLDOWN_TTL_SECONDS = 60;

type SessionCacheTtlDecision = {
  ttlMs: number;
  expiresAt: number;
  source: 'cookie-expiry' | 'fallback';
  cookieExpiresAt?: number;
};

/**
 * @description Apple Store 查询 session 缓存服务.
 *
 * 该服务封装 AccountSessionContext/CookieContainer 与 Redis 存储之间的转换,
 * 并维护地区预热索引和账号地区反向索引。账号初始化和业务查询服务共享
 * 这一份 Redis session 缓存格式。
 */
@Injectable()
export class AccountSessionCacheService {
  private readonly logger = new Logger(AccountSessionCacheService.name);

  /**
   * @description 注入缓存和 Cookie 容器工厂.
   * @param cacheService Redis 分布式缓存服务
   * @param cookieJarService Cookie 容器工厂
   */
  constructor(
    private readonly cacheService: DistributedCacheService,
    private readonly cookieJarService: CookieJarService,
  ) { }

  /**
   * @description 判断指定 cacheKey 是否已有可用 session.
   * @param cacheKey 缓存 key, 格式为 accountIdentity:regionPath
   * @returns true 表示 Redis 中已有未过期 session
   */
  async hasValidSession(cacheKey: string): Promise<boolean> {
    return this.cacheService.hasValidSession(cacheKey);
  }

  /**
   * @description 从 Redis 恢复查询 session.
   * @param cacheKey 缓存 key, 格式为 accountIdentity:regionPath
   * @returns 反序列化后的上下文和 Cookie 容器; 未命中时返回 null
   */
  async restoreSession(
    cacheKey: string,
  ): Promise<{ context: AccountSessionContext; cookies: CookieContainer; createdAt: number; email: string } | null> {
    const serialized = await this.cacheService.getSession(cacheKey);
    if (!serialized) {
      return null;
    }
    if (serialized.expiresAt && serialized.expiresAt <= Date.now()) {
      await this.evictSession(cacheKey);
      return null;
    }

    return this.deserializeSession(serialized);
  }

  /**
   * @description 将已初始化的 session 序列化后存入 Redis.
   *
   * 同时维护地区级预热索引 (gc:warmed:{regionPath} → accountIdentity),
   * 使账号池选择逻辑能 O(1) 查找已预热账号。
   *
   * @param cacheKey 缓存 key, 格式为 accountIdentity:regionPath
   * @param context 已初始化的查询上下文
   * @param cookies 会话 Cookie 容器
   * @sideEffects 写入 Redis session、重置使用计数、维护地区预热索引和账号地区反向索引
   */
  async saveSession(
    cacheKey: string,
    context: AccountSessionContext,
    cookies: CookieContainer,
  ): Promise<void> {
    const email = context.accountInfoList[context.currentAccountIndex]?.acc || 'unknown';
    const ttlDecision = this.resolveSessionCacheTtl(cookies);
    const serialized = this.serializeSession(context, cookies, email, ttlDecision);
    await this.cacheService.saveSession(cacheKey, serialized, ttlDecision.ttlMs);
    await this.cacheService.clearUsageStats(cacheKey);

    const { accountIdentity, regionPath } = this.parseCacheKey(cacheKey);
    if (regionPath) {
      await this.cacheService.setWarmedAccount(regionPath, accountIdentity || email, ttlDecision.ttlMs);
      await this.cacheService.setAccountRegion(accountIdentity || email, regionPath, ttlDecision.ttlMs);
    }

    this.logger.log(
      `[cache] 查询 session 已保存: key=${cacheKey}, ttl=${Math.round(ttlDecision.ttlMs / 1000)}s, ` +
      `source=${ttlDecision.source}, cookieExpiresAt=${ttlDecision.cookieExpiresAt || '(none)'}`,
    );
  }

  /**
   * @description 淘汰 Redis session 并清理相关地区预热索引.
   * @param cacheKey 缓存 key, 格式为 accountIdentity:regionPath
   * @sideEffects 删除 Redis session、预热集合成员和账号地区绑定
   */
  async evictSession(cacheKey: string): Promise<void> {
    await this.cacheService.evictSession(cacheKey);
    await this.cacheService.clearUsageStats(cacheKey);

    const { accountIdentity, regionPath } = this.parseCacheKey(cacheKey);
    if (regionPath && accountIdentity) {
      await this.cacheService.removeWarmedAccountMember(regionPath, accountIdentity);
      await this.cacheService.deleteAccountRegion(accountIdentity);
    }

    this.logger.log(`[cache] 已淘汰 (Redis): key=${cacheKey}`);
  }

  /**
   * @description 异步记录 session 查询使用情况, 达到阈值时淘汰 session 并设置冷却锁.
   *
   * 该方法不阻塞当前查询响应。冷却策略用于降低同一账号、同一地区 session
   * 在短时间内被过度复用导致风控的概率。
   *
   * @param cacheKey 缓存 key, 格式为 accountIdentity:regionPath
   * @sideEffects 写入 Redis 使用统计; 达到阈值时淘汰 session 并设置冷却锁
   */
  recordUsageAndCooldown(cacheKey: string): void {
    this.cacheService.recordUsage(cacheKey, ROTATION_WINDOW_MS).then(async (stats) => {
      if (stats.queryCount >= ROTATION_QUERY_THRESHOLD) {
        this.logger.log(
          `[rotation] 🔄 账号达到 ${ROTATION_QUERY_THRESHOLD} 次查询, 清除上下文并冷却: ${cacheKey}`,
        );
        await this.evictSession(cacheKey);
        await this.cacheService.setCooldownLock(cacheKey, COOLDOWN_TTL_SECONDS);
      }
    }).catch((err) => {
      this.logger.warn(`[usage] 使用统计记录失败: ${cacheKey} — ${err.message}`);
    });
  }

  /**
   * @description 将 AccountSessionContext + CookieContainer 序列化为 Redis 可存储格式.
   * @param context 查询上下文
   * @param cookies 会话 Cookie 容器
   * @param email 当前账号邮箱
   * @returns 可 JSON.stringify 的序列化对象
   */
  private serializeSession(
    context: AccountSessionContext,
    cookies: CookieContainer,
    email: string,
    ttlDecision: SessionCacheTtlDecision,
  ): SerializedSession {
    return {
      context: {
        currentAccountIndex: context.currentAccountIndex,
        accountInfoList: context.accountInfoList.map((ai) => ({
          acc: ai.acc,
          pwd: ai.pwd,
          available: ai.available,
          isLogin: ai.isLogin,
          loginCookies: Object.fromEntries(ai.loginCookies),
        })),
        x_aos_stk: context.x_aos_stk,
        x_as_actk: context.x_as_actk,
        server: context.server,
        countryURL: context.countryURL,
        queryURL: context.queryURL,
        internalReturnCode: context.internalReturnCode,
        beRiskCtrl: context.beRiskCtrl,
        maxAttemptReached: context.maxAttemptReached,
      },
      cookies: this.serializeCookies(cookies),
      createdAt: Date.now(),
      ttlMs: ttlDecision.ttlMs,
      expiresAt: ttlDecision.expiresAt,
      email,
    };
  }

  /**
   * @description 根据接口返回 Cookie 过期时间计算 Redis 查询 session TTL.
   *
   * 初始化链路中 IDMSA/Apple Store 会返回带 Max-Age/Expires 的 Cookie。这里取
   * 最早的明确过期时间并预留安全余量, 让 Redis session 不会活得比接口凭据更久;
   * 如果没有明确过期时间, 才回退到原 8 分钟兜底值。
   *
   * @param cookies 初始化完成后的 Cookie 容器
   * @returns TTL 决策结果
   */
  private resolveSessionCacheTtl(cookies: CookieContainer): SessionCacheTtlDecision {
    const now = Date.now();
    const fallbackTtlMs = this.parsePositiveIntEnv(
      'ACCOUNT_SESSION_CACHE_FALLBACK_TTL_MS',
      DEFAULT_SESSION_CACHE_FALLBACK_TTL_MS,
    );
    const safetyMarginMs = this.parsePositiveIntEnv(
      'ACCOUNT_SESSION_CACHE_TTL_SAFETY_MARGIN_MS',
      DEFAULT_SESSION_CACHE_TTL_SAFETY_MARGIN_MS,
    );
    const maxTtlMs = this.parsePositiveIntEnv(
      'ACCOUNT_SESSION_CACHE_MAX_TTL_MS',
      DEFAULT_SESSION_CACHE_MAX_TTL_MS,
    );
    const cookieExpiresAt = cookies.getEarliestExpiresAt(now);

    if (cookieExpiresAt && cookieExpiresAt > now) {
      const ttlMs = Math.max(1000, Math.min(cookieExpiresAt - now - safetyMarginMs, maxTtlMs));
      return {
        ttlMs,
        expiresAt: now + ttlMs,
        source: 'cookie-expiry',
        cookieExpiresAt,
      };
    }

    const ttlMs = Math.min(fallbackTtlMs, maxTtlMs);
    return {
      ttlMs,
      expiresAt: now + ttlMs,
      source: 'fallback',
    };
  }

  /**
   * @description 解析正整数环境变量.
   * @param key 环境变量名
   * @param fallback 默认值
   * @returns 解析后的正整数; 非法时返回默认值
   */
  private parsePositiveIntEnv(key: string, fallback: number): number {
    const value = Number.parseInt(process.env[key] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  /**
   * @description 从 Redis 序列化对象恢复查询上下文和 Cookie 容器.
   * @param data Redis 中的 session 数据
   * @returns 可直接用于查询的上下文、Cookie 容器和元信息
   */
  private deserializeSession(
    data: SerializedSession,
  ): { context: AccountSessionContext; cookies: CookieContainer; createdAt: number; email: string } {
    const context: AccountSessionContext = {
      currentAccountIndex: data.context.currentAccountIndex,
      accountInfoList: data.context.accountInfoList.map((ai) => ({
        acc: ai.acc,
        pwd: ai.pwd,
        available: ai.available,
        isLogin: ai.isLogin,
        loginCookies: new Map(Object.entries(ai.loginCookies)),
      })),
      x_aos_stk: data.context.x_aos_stk,
      x_as_actk: data.context.x_as_actk,
      server: data.context.server,
      countryURL: data.context.countryURL,
      queryURL: data.context.queryURL,
      internalReturnCode: data.context.internalReturnCode,
      beRiskCtrl: data.context.beRiskCtrl,
      maxAttemptReached: data.context.maxAttemptReached,
    };

    return {
      context,
      cookies: this.deserializeCookies(data.cookies),
      createdAt: data.createdAt,
      email: data.email,
    };
  }

  /**
   * @description CookieContainer → Record<string, string>.
   * @param cookies 会话 Cookie 容器
   * @returns 可 JSON 序列化的 Cookie 键值表
   */
  private serializeCookies(cookies: CookieContainer): Record<string, string> {
    const result: Record<string, string> = {};
    const str = cookies.toRequestString();
    if (!str) return result;

    for (const pair of str.split('; ')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        result[pair.substring(0, eqIdx)] = pair.substring(eqIdx + 1);
      }
    }

    return result;
  }

  /**
   * @description Record<string, string> → CookieContainer.
   * @param data Redis 中的 Cookie 键值表
   * @returns 新建并填充后的 Cookie 容器
   */
  private deserializeCookies(data: Record<string, string>): CookieContainer {
    const container = this.cookieJarService.createContainer();
    const headers = Object.entries(data).map(([name, value]) => `${name}=${value}`);
    container.mergeFromSetCookieHeaders(headers);
    return container;
  }

  /**
   * @description 解析 accountIdentity:regionPath 格式缓存 key.
   * @param cacheKey 缓存 key
   * @returns 账号身份和地区路径
   */
  private parseCacheKey(cacheKey: string): { accountIdentity: string; regionPath: string } {
    const colonIdx = cacheKey.indexOf(':');
    if (colonIdx === -1) {
      return { accountIdentity: cacheKey, regionPath: '' };
    }

    return {
      accountIdentity: cacheKey.substring(0, colonIdx),
      regionPath: cacheKey.substring(colonIdx + 1),
    };
  }
}
