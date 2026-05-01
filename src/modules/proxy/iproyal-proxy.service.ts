import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../database/redis.service';
import { v4 as uuidv4 } from 'uuid';
import { ProxyConfig, ProxyProvider } from './proxy-config.interface';

/**
 * @file iproyal-proxy.service.ts
 * @description iProyal 旋转代理服务 — 替代 DecodoProxyService.
 *
 * 设计动机:
 * Decodo (gate.decodo.com) 连接不稳定, Socks5 Authentication 频繁失败.
 * 切换到 iProyal (geo.iproyal.com:11201) 作为主代理服务商.
 *
 * iProyal 代理规则:
 * - 基础用户名: sSNXhZIJ1oVvnwia, 密码: CyCvcdZ3ZLEcpgnz
 * - SOCKS5: geo.iproyal.com:11201, protocol: socks5://
 * - 每次使用基础凭证访问, 服务商随机分配 IP
 * - Sticky session 通过密码后缀实现:
 *   password → {password}_session-{randomText}_lifetime-{duration}
 *   同一 session 在 lifetime 内保持同一出口 IP
 *
 * 与 Decodo 的关键差异:
 * - Decodo: sticky session 通过 **用户名** (user-{base}-session-{tag})
 * - iProyal: sticky session 通过 **密码后缀** ({password}_session-{tag}_lifetime-{dur})
 * - 协议: socks5 (非 socks5h)
 * - Session 默认 lifetime: 30m (非 24h)
 */

/** Redis key 前缀 — 存储 email → sessionTag 映射 */
const REDIS_KEY_PREFIX = 'iproyal:session:';

/**
 * Session 映射 TTL (秒).
 * 与 iProyal 的 session lifetime 保持一致:
 * - 30m = 1800s (默认)
 * - 实际以 .env 中 IPROYAL_SESSION_LIFETIME 为准
 */
const SESSION_LIFETIME_TO_SECONDS: Record<string, number> = {
  '10m': 600,
  '30m': 1800,
  '1h': 3600,
  '24h': 86400,
  '7d': 604800,
};

@Injectable()
export class IProyalProxyService implements ProxyProvider {
  private readonly logger = new Logger(IProyalProxyService.name);

  /** iProyal 网关主机 */
  private readonly host: string;
  /** iProyal 网关端口 */
  private readonly port: number;
  /** iProyal 基础用户名 */
  private readonly baseUsername: string;
  /** iProyal 基础密码 (不带 session 后缀) */
  private readonly basePassword: string;
  /** iProyal sticky session 过期时间标识 (如 '30m') */
  private readonly sessionLifetime: string;
  /** session TTL 对应的秒数 — 用于 Redis TTL */
  private readonly sessionTtlSeconds: number;

  /**
   * 内存缓存: email → sessionTag
   * 避免每次都查 Redis, 热路径直接命中内存.
   * Redis 仅作持久化兜底 (服务重启后恢复).
   */
  private readonly sessionMap = new Map<string, string>();

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    this.host = this.configService.get<string>('IPROYAL_HOST', 'geo.iproyal.com');
    this.port = this.configService.get<number>('IPROYAL_PORT', 11201);
    this.baseUsername = this.configService.get<string>('IPROYAL_USERNAME', '');
    this.basePassword = this.configService.get<string>('IPROYAL_PASSWORD', '');
    this.sessionLifetime = this.configService.get<string>('IPROYAL_SESSION_LIFETIME', '30m');
    this.sessionTtlSeconds = SESSION_LIFETIME_TO_SECONDS[this.sessionLifetime] || 1800;

    if (!this.baseUsername || !this.basePassword) {
      this.logger.error('IPROYAL_USERNAME 或 IPROYAL_PASSWORD 未配置, 代理服务将无法正常工作');
    } else {
      this.logger.log(
        `✓ iProyal 代理已初始化: ${this.host}:${this.port}, username=${this.baseUsername}, lifetime=${this.sessionLifetime}`,
      );
    }
  }

  // ==================== 核心方法 ====================

  /**
   * @description 为指定账号获取 sticky session 代理 — 同一账号在 lifetime 内使用同一出口 IP.
   *
   * 查找优先级: 内存 Map → Redis → 生成新 tag
   *
   * @param email 账号邮箱 (作为 session 绑定的 key)
   * @returns 代理配置 (永远非 null)
   */
  async acquireForAccount(email: string): Promise<ProxyConfig> {
    const normalizedEmail = email.toLowerCase();

    // 1. 查内存缓存 — 热路径, O(1) 命中
    let sessionTag = this.sessionMap.get(normalizedEmail);
    if (sessionTag) {
      this.logger.debug(`[acquireForAccount] 内存命中: ${normalizedEmail} → ${sessionTag}`);
      return this.buildConfig(sessionTag);
    }

    // 2. 查 Redis — 服务重启后的恢复路径
    try {
      const redisTag = await this.redisService.get(`${REDIS_KEY_PREFIX}${normalizedEmail}`);
      if (redisTag) {
        this.sessionMap.set(normalizedEmail, redisTag);
        this.logger.log(`[acquireForAccount] Redis 恢复: ${normalizedEmail} → ${redisTag}`);
        return this.buildConfig(redisTag);
      }
    } catch (err: any) {
      // Redis 不可用时降级为纯内存, 不阻塞业务
      this.logger.warn(`[acquireForAccount] Redis 查询失败, 降级为内存模式: ${err.message}`);
    }

    // 3. 生成新 sessionTag — 首次使用该账号
    sessionTag = this.generateSessionTag();
    this.sessionMap.set(normalizedEmail, sessionTag);
    this.logger.log(`[acquireForAccount] 新建 session: ${normalizedEmail} → ${sessionTag}`);

    // 异步写 Redis, 不阻塞主流程
    this.persistSessionTag(normalizedEmail, sessionTag).catch((err) => {
      this.logger.warn(`[acquireForAccount] Redis 持久化失败: ${err.message}`);
    });

    return this.buildConfig(sessionTag);
  }

  /**
   * @description 获取随机 IP 代理 — 每次请求都使用不同的出口 IP.
   *
   * 使用 iProyal 基础凭证 (不带 session 后缀), 服务商每次分配随机 IP.
   * 适用于无需 IP 一致性的场景 (如获取 bag.xml 等公共接口).
   *
   * @returns 代理配置
   */
  acquireRandom(): ProxyConfig {
    return {
      protocol: 'socks5',
      host: this.host,
      port: this.port,
      username: this.baseUsername,
      password: this.basePassword,
      sessionTag: '',
    };
  }

  /**
   * @description 直接根据指定 sessionTag 构建 sticky session 代理配置.
   *
   * 用于恢复已经持久化的业务会话, 避免强依赖 email → sessionTag 的当前映射关系.
   *
   * @param sessionTag sticky session 标识
   * @returns 对应的代理配置
   */
  getConfigForSessionTag(sessionTag: string): ProxyConfig {
    return this.buildConfig(sessionTag);
  }

  /**
   * @description 释放账号的 session 映射 — 账号登出时调用.
   *
   * 清除内存 + Redis 中的映射关系.
   * 下次该账号重新登录时会获得新的 sessionTag (新的出口 IP).
   *
   * @param email 账号邮箱
   */
  async releaseSession(email: string): Promise<void> {
    const normalizedEmail = email.toLowerCase();
    this.sessionMap.delete(normalizedEmail);
    try {
      await this.redisService.del(`${REDIS_KEY_PREFIX}${normalizedEmail}`);
      this.logger.log(`[releaseSession] 已释放: ${normalizedEmail}`);
    } catch (err: any) {
      this.logger.warn(`[releaseSession] Redis 删除失败: ${err.message}`);
    }
  }

  /**
   * @description 轮换代理 session — 当前代理故障时生成新的 sessionTag.
   *
   * 新 tag 自动获得新出口 IP (iProyal 保证), 无需 "禁用" 旧代理.
   *
   * @param email 账号邮箱
   * @returns 使用新 sessionTag 的代理配置
   */
  async rotateSession(email: string): Promise<ProxyConfig> {
    const normalizedEmail = email.toLowerCase();
    const newTag = this.generateSessionTag();
    this.sessionMap.set(normalizedEmail, newTag);
    this.logger.log(`[rotateSession] 轮换 session: ${normalizedEmail} → ${newTag}`);

    this.persistSessionTag(normalizedEmail, newTag).catch((err) => {
      this.logger.warn(`[rotateSession] Redis 持久化失败: ${err.message}`);
    });

    return this.buildConfig(newTag);
  }

  // ==================== 私有辅助方法 ====================

  /**
   * @description 根据 sessionTag 构建完整的代理配置.
   *
   * iProyal sticky session 机制: 密码设为 {basePassword}_session-{tag}_lifetime-{dur},
   * 使用该密码的所有请求在 lifetime 内共享同一出口 IP.
   *
   * @param sessionTag session 标识 (空字符串表示随机 IP)
   * @returns 完整的代理配置
   */
  private buildConfig(sessionTag: string): ProxyConfig {
    // sticky session: 密码附加 session tag + lifetime
    const password = sessionTag
      ? `${this.basePassword}_session-${sessionTag}_lifetime-${this.sessionLifetime}`
      : this.basePassword;

    return {
      protocol: 'socks5',
      host: this.host,
      port: this.port,
      username: this.baseUsername,
      password,
      sessionTag,
    };
  }

  /**
   * @description 生成唯一的 session tag — 使用 UUID v4 去掉横线, 取前 12 位.
   *
   * 12 位 hex 足够避免碰撞 (16^12 ≈ 2.8 × 10^14), 同时保持密码长度合理.
   */
  private generateSessionTag(): string {
    return uuidv4().replace(/-/g, '').substring(0, 12);
  }

  /**
   * @description 将 email → sessionTag 映射持久化到 Redis.
   *
   * TTL 与 iProyal 的 session lifetime 一致.
   * 服务重启后可从 Redis 恢复映射, 避免不必要的 IP 切换.
   */
  private async persistSessionTag(email: string, tag: string): Promise<void> {
    await this.redisService.set(`${REDIS_KEY_PREFIX}${email}`, tag, this.sessionTtlSeconds);
  }
}
