import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../database/redis.service';
import { v4 as uuidv4 } from 'uuid';

/**
 * @file decodo-proxy.service.ts
 * @description Decodo 旋转代理服务 — 替代原 ProxyPoolService (MySQL proxy_pool 表).
 *
 * 设计动机:
 * 原架构将 100 条相同 Decodo 网关的 session URL 存入 MySQL proxy_pool 表,
 * 每次请求都查 DB 获取代理. 这对 Decodo 的旋转代理模型完全错误:
 * - 所有记录指向同一网关 (gate.decodo.com:7000), MySQL 查询纯属浪费
 * - 一个 session 认证失败会触发 deactivate(), 逐步耗尽所有 "代理"
 * - sticky session 场景下 getRandomActive() 每次返回不同 session tag, 破坏 IP 一致性
 *
 * 新设计:
 * 1. 凭证从 .env 读取, 运行时按需生成代理配置 (零 DB 依赖)
 * 2. sticky session 通过 Decodo 的 username-session-{tag} 机制实现
 * 3. 账号 → sessionTag 映射存在内存 Map + Redis (24h TTL), 保证同一账号始终用同一出口 IP
 * 4. 代理故障时调用 rotateSession() 生成新 tag, 自动获得新出口 IP
 *
 * Decodo 代理规则 (20260414 补充说明):
 * - 基础用户名和密码从环境变量读取
 * - SOCKS5: gate.decodo.com:7000, protocol: socks5h://
 * - 每次使用基础用户名访问, 服务商随机分配 IP
 * - 修改用户名为 user-spzlof027g-session-{randomTxt}, 该 session 对应的 IP 保留 24 小时
 *
 * Reference: Decodo (Smartproxy) 官方文档 — Sticky Session via Username
 */

/** Redis key 前缀 — 存储 email → sessionTag 映射 */
const REDIS_KEY_PREFIX = 'decodo:session:';
/** Session 映射 TTL (秒) — 与 Decodo 的 24h session 保持一致 */
const SESSION_TTL_SECONDS = 24 * 3600;

import { ProxyConfig, ProxyProvider } from './proxy-config.interface';

/**
 * @deprecated 使用 ProxyConfig 代替. DecodoProxyConfig 是向后兼容的类型别名.
 */
export type DecodoProxyConfig = ProxyConfig;

/** 同时导出通用接口, 方便新代码直接使用 */
export { ProxyConfig } from './proxy-config.interface';


@Injectable()
export class DecodoProxyService implements ProxyProvider {
  private readonly logger = new Logger(DecodoProxyService.name);

  /** Decodo 网关主机 */
  private readonly host: string;
  /** Decodo 网关端口 */
  private readonly port: number;
  /** Decodo 基础用户名 (不带 session 后缀) */
  private readonly baseUsername: string;
  /** Decodo 密码 */
  private readonly password: string;

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
    this.host = this.configService.get<string>('DECODO_HOST', 'gate.decodo.com');
    this.port = this.configService.get<number>('DECODO_PORT', 7000);
    this.baseUsername = this.configService.get<string>('DECODO_USERNAME', '');
    this.password = this.configService.get<string>('DECODO_PASSWORD', '');

    const isActiveProvider = this.configService.get<string>('PROXY_PROVIDER', 'iproyal') === 'decodo';
    if (!this.baseUsername || !this.password) {
      if (!isActiveProvider) return;
      this.logger.error('DECODO_USERNAME 或 DECODO_PASSWORD 未配置, 代理服务将无法正常工作');
    } else if (isActiveProvider) {
      this.logger.log(
        `✓ Decodo 代理已初始化: ${this.host}:${this.port}, username=${this.baseUsername}`,
      );
    }
  }

  // ==================== 核心方法 ====================

  /**
   * @description 为指定账号获取 sticky session 代理 — 同一账号始终使用同一出口 IP.
   *
   * 查找优先级: 内存 Map → Redis → 生成新 tag
   * 这是业务层替代原 acquireProxy() 的主要方法:
   * - 登录: acquireForAccount(email) → 绑定代理 IP
   * - 后续请求: acquireForAccount(email) → 复用同一 IP
   * - 2FA 验证: acquireForAccount(email) → 保证 IP 不变 (修复原实现的 bug)
   *
   * @param email 账号邮箱 (作为 session 绑定的 key)
   * @returns Decodo 代理配置 (永远非 null, Decodo 网关级别保证可用)
   */
  async acquireForAccount(email: string): Promise<DecodoProxyConfig> {
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
   * 使用 Decodo 基础用户名 (不带 session 后缀), 服务商每次分配随机 IP.
   * 适用于无需 IP 一致性的场景 (如获取 bag.xml 等公共接口).
   *
   * @returns Decodo 代理配置
   */
  async acquireRandom(): Promise<DecodoProxyConfig> {
    return {
      protocol: 'socks5h',
      host: this.host,
      port: this.port,
      username: this.baseUsername,
      password: this.password,
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
  async getConfigForSessionTag(sessionTag: string): Promise<DecodoProxyConfig> {
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
   * 替代原 deactivate() + getRandomActive() 的两步操作.
   * 新 tag 自动获得新出口 IP (Decodo 保证), 无需 "禁用" 旧代理.
   *
   * @param email 账号邮箱
   * @returns 使用新 sessionTag 的代理配置
   */
  async rotateSession(email: string): Promise<DecodoProxyConfig> {
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
   * Decodo sticky session 机制: 用户名设为 {baseUsername}-session-{tag},
   * 使用该用户名的所有请求在 24h 内共享同一出口 IP.
   *
   * @param sessionTag session 标识 (空字符串表示随机 IP)
   * @returns 完整的代理配置
   */
  private buildConfig(sessionTag: string): DecodoProxyConfig {
    // sticky session: 用户名附加 session tag
    const username = sessionTag
      ? `user-${this.baseUsername}-session-${sessionTag}`
      : this.baseUsername;

    return {
      protocol: 'socks5h',
      host: this.host,
      port: this.port,
      username,
      password: this.password,
      sessionTag,
    };
  }

  /**
   * @description 生成唯一的 session tag — 使用 UUID v4 去掉横线, 取前 12 位.
   *
   * 12 位 hex 足够避免碰撞 (16^12 ≈ 2.8 × 10^14), 同时保持用户名长度合理
   * (Decodo 对用户名长度有上限限制).
   */
  private generateSessionTag(): string {
    return uuidv4().replace(/-/g, '').substring(0, 12);
  }

  /**
   * @description 将 email → sessionTag 映射持久化到 Redis.
   *
   * TTL 24h 与 Decodo 的 session IP 保留时间一致.
   * 服务重启后可从 Redis 恢复映射, 避免不必要的 IP 切换.
   */
  private async persistSessionTag(email: string, tag: string): Promise<void> {
    await this.redisService.set(`${REDIS_KEY_PREFIX}${email}`, tag, SESSION_TTL_SECONDS);
  }
}
