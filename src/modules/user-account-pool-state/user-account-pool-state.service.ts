import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../../database/redis.service';
import { CACHE_KEYS } from '../../constants/cache-keys.constants';
import { AppleAccount } from '../../entities/apple-account.entity';
import { DistributedCacheService, SerializedPoolEntry } from '../distributed-cache';
import { UserAccountPoolIdentityService } from '../user-account-pool-core/user-account-pool-identity.service';
import {
  ActiveAccountCredential,
  PoolEntry,
  PoolStatus,
  USER_POOL_ROTATION_THRESHOLD,
  USER_POOL_USAGE_TTL_SECONDS,
} from '../user-account-pool-core/user-account-pool.types';

/**
 * @description 用户账号池状态服务.
 *
 * 负责账号池 Redis 状态、使用计数、过期标记、退出清理和状态查询。
 * 它不执行 Apple 登录, 也不决定余额查询选号策略。
 */
@Injectable()
export class UserAccountPoolStateService {
  private readonly logger = new Logger(UserAccountPoolStateService.name);

  constructor(
    @InjectRepository(AppleAccount)
    private readonly appleAccountRepo: Repository<AppleAccount>,
    private readonly redisService: RedisService,
    private readonly cacheService: DistributedCacheService,
    private readonly identityService: UserAccountPoolIdentityService,
  ) { }

  /**
   * @description 将账号添加到 Redis 账号池.
   * @param accountKey 用户组内账号身份 key
   * @param entry 账号池条目
   * @sideEffects 写入 Redis Hash 和账号集合
   */
  async addToPool(accountKey: string, entry: PoolEntry): Promise<void> {
    const serialized: SerializedPoolEntry = {
      groupId: entry.groupId ?? null,
      email: entry.email,
      password: entry.password,
      twoFAUrl: entry.twoFAUrl,
      sessionId: entry.sessionId,
      region: entry.region,
      creditDisplay: entry.creditDisplay,
      name: entry.name,
      usageCount: entry.usageCount,
      lastUsedAt: entry.lastUsedAt,
      status: entry.status,
      errorMessage: entry.errorMessage,
    };
    await this.cacheService.saveAccount(accountKey, serialized);
  }

  /**
   * @description 初始化 Redis 使用计数器.
   * @param accountKey 用户组内账号身份 key
   * @sideEffects 写入 ACCOUNT_USAGE 计数器并设置 TTL
   */
  async initUsageCounter(accountKey: string): Promise<void> {
    try {
      const key = CACHE_KEYS.ACCOUNT_USAGE.build(accountKey);
      await this.redisService.getClient().set(key, '0', 'EX', USER_POOL_USAGE_TTL_SECONDS);
    } catch (error: any) {
      this.logger.warn(`[UserPool] Redis 初始化计数失败: ${accountKey} — ${error.message}`);
    }
  }

  /**
   * @description 记录账号使用次数 — Redis 原子递增.
   * @param email Apple ID 邮箱
   * @param groupId 用户组 ID
   * @sideEffects 更新 Redis 计数器和账号池 lastUsedAt
   */
  async recordUsage(email: string, groupId: number | null = null): Promise<void> {
    const emailKey = email.toLowerCase();
    const accountKey = this.identityService.buildAccountIdentity(emailKey, groupId);

    try {
      const redisKey = CACHE_KEYS.ACCOUNT_USAGE.build(accountKey);
      const newCount = await this.redisService.getClient().incr(redisKey);
      const ttl = await this.redisService.getClient().ttl(redisKey);
      if (ttl < 0) {
        await this.redisService.getClient().expire(redisKey, USER_POOL_USAGE_TTL_SECONDS);
      }

      await this.cacheService.updateAccountFields(accountKey, {
        usageCount: String(newCount),
        lastUsedAt: String(Date.now()),
      });

      this.logger.debug(`[UserPool] 使用记录: ${emailKey}, usageCount=${newCount}`);

      if (newCount >= USER_POOL_ROTATION_THRESHOLD) {
        await this.logRotationHint(groupId);
      }
    } catch (error: any) {
      this.logger.warn(`[UserPool] 使用记录更新失败: ${emailKey} — ${error.message}`);
    }
  }

  /**
   * @description 标记账号 session 过期 — 清除 managed session 并重置状态.
   * @param email Apple ID 邮箱
   * @param groupId 用户组 ID
   * @sideEffects 清理 managed session Redis 状态、账号池状态、预热缓存和使用计数
   */
  async markExpired(email: string, groupId: number | null = null): Promise<void> {
    const emailKey = email.toLowerCase();
    const accountKey = this.identityService.buildAccountIdentity(emailKey, groupId);
    const entry = await this.cacheService.getAccount(accountKey);
    if (!entry) return;

    this.logger.warn(`[UserPool] 标记 session 过期: ${emailKey}`);

    if (entry.sessionId) {
      await this.cleanupManagedSessionState(entry.sessionId, emailKey);
    }

    await this.cacheService.updateAccountFields(accountKey, {
      status: 'expired',
      sessionId: '',
      usageCount: '0',
      lastUsedAt: '0',
    });
    await this.clearAccountWarmupState(accountKey);

    try {
      await this.redisService.getClient().del(CACHE_KEYS.ACCOUNT_USAGE.build(accountKey));
    } catch { }
  }

  /**
   * @description 退出单个用户账号 — 清除 managed session Redis 状态、账号池条目和使用计数.
   * @param email Apple ID 邮箱
   * @param groupId 用户组 ID
   * @sideEffects 清理 managed session、预热状态和账号池条目
   */
  async logoutSingle(email: string, groupId: number | null = null): Promise<void> {
    const emailKey = email.toLowerCase();
    const accountKey = this.identityService.buildAccountIdentity(emailKey, groupId);
    const entry = await this.cacheService.getAccount(accountKey);

    if (!entry) {
      this.logger.warn(`[UserPool] 退出账号不在池中: ${emailKey}`);
      return;
    }

    this.logger.log(`[UserPool] 退出单个账号: ${emailKey}`);

    if (entry.sessionId) {
      try {
        await this.cleanupManagedSessionState(entry.sessionId, emailKey);
        this.logger.log(`[UserPool] ✓ 已清除 session: ${entry.sessionId}`);
      } catch (error: any) {
        this.logger.warn(`[UserPool] 清除 session 失败: ${error.message}`);
      }
    }

    await this.clearAccountWarmupState(accountKey);
    await this.cacheService.removeAccount(accountKey);
    try {
      await this.redisService.getClient().del(CACHE_KEYS.ACCOUNT_USAGE.build(accountKey));
    } catch { }

    this.logger.log(`[UserPool] ✓ 已退出账号: ${emailKey}`);
  }

  /**
   * @description 清除指定用户组所有用户账号.
   * @param groupId 用户组 ID
   * @sideEffects 清除账号池 Redis 条目与预热状态
   */
  async clearAll(groupId: number | null = null): Promise<void> {
    const accountKeys = await this.cacheService.getAccountEmailsByGroup(groupId);
    this.logger.log(`[UserPool] 清除所有用户账号: ${accountKeys.length} 个`);

    await Promise.all(accountKeys.map((accountKey) => this.clearAccountWarmupState(accountKey)));
    await this.cacheService.clearAllAccounts(groupId);
    this.logger.log('[UserPool] ✓ 已清除所有用户账号');
  }

  /**
   * @description 获取账号池状态摘要.
   * @param groupId 用户组 ID
   * @returns 账号池状态摘要
   */
  async getPoolStatus(groupId: number | null = null): Promise<PoolStatus> {
    const accounts = await this.cacheService.getAllAccounts(groupId);
    return {
      total: accounts.length,
      active: accounts.filter((a) => a.status === 'active').length,
      cnAccounts: accounts.filter((a) => a.status === 'active' && a.region === 'cn').length,
      expired: accounts.filter((a) => a.status === 'expired').length,
      unused: accounts.filter((a) => a.status === 'unused').length,
      needs2fa: accounts.filter((a) => a.status === 'needs_2fa').length,
      loginFailed: accounts.filter((a) => a.status === 'login_failed').length,
      accounts: accounts.map((a) => ({
        email: a.email,
        region: a.region,
        status: a.status,
        usageCount: a.usageCount,
        creditDisplay: a.creditDisplay,
        name: a.name,
      })),
    };
  }

  /**
   * @description 获取所有活跃账号的凭据.
   * @param groupId 用户组 ID
   * @returns 活跃账号凭据列表
   */
  async getActiveAccountCredentials(groupId: number | null = null): Promise<ActiveAccountCredential[]> {
    const allAccounts = await this.cacheService.getAllAccounts(groupId);
    return allAccounts
      .filter((entry) => entry.status === 'active' && entry.sessionId)
      .map((entry) => ({
        email: entry.email,
        password: entry.password,
        accountKey: this.identityService.buildAccountIdentity(entry.email, groupId),
        groupId,
      }));
  }

  /**
   * @description 检查指定用户组是否存在可直接用于查询的已登录账号 session.
   * @param groupId 用户组 ID; null 表示全局资源池
   * @returns true 表示至少存在一个 status='active' 且带 sessionId 的账号
   */
  async hasActiveGroupSessions(groupId: number | null): Promise<boolean> {
    const activeAccountCount = await this.cacheService.getActiveAccountCount(groupId);
    return activeAccountCount > 0;
  }

  /**
   * @description 检查指定用户组是否拥有任何账号.
   * @param groupId 用户组 ID; null 表示全局资源池
   * @returns true 表示有账号或检查失败时降级允许轮询
   */
  async hasGroupAccounts(groupId: number | null): Promise<boolean> {
    try {
      const cachedEmails = await this.cacheService.getAccountEmailsByGroup(groupId);
      if (cachedEmails.length > 0) return true;

      const dbCount = await this.appleAccountRepo.count({
        where: groupId !== null ? { groupId } : undefined,
      });
      return dbCount > 0;
    } catch (error: any) {
      this.logger.warn(
        `[hasGroupAccounts] 检查失败, 降级为 true (允许继续轮询): groupId=${groupId}, error=${error.message}`,
      );
      return true;
    }
  }

  /**
   * @description 清理账号当前预热 session、预热索引、地区绑定、冷却锁和 session 使用统计.
   * @param accountKey 用户组内账号身份 key
   * @sideEffects 删除 Redis session、索引、冷却锁与使用统计
   */
  async clearAccountWarmupState(accountKey: string): Promise<void> {
    const regionPath = await this.cacheService.getAccountRegion(accountKey);
    if (!regionPath) return;

    const cacheKey = `${accountKey}:${regionPath}`;
    try {
      await Promise.all([
        this.cacheService.evictSession(cacheKey),
        this.cacheService.removeWarmedAccountMember(regionPath, accountKey),
        this.cacheService.deleteAccountRegion(accountKey),
        this.redisService.getClient().del(CACHE_KEYS.USAGE.build(cacheKey)),
        this.redisService.getClient().del(CACHE_KEYS.COOLDOWN.build(cacheKey)),
      ]);
    } catch (error: any) {
      this.logger.warn(`[UserPool] 清理账号预热状态失败: accountKey=${accountKey} — ${error.message}`);
    }
  }

  /**
   * @description 后台检查是否有未使用账号, 仅输出轮换提示.
   * @param groupId 用户组 ID
   */
  private async logRotationHint(groupId: number | null): Promise<void> {
    const allAccounts = await this.cacheService.getAllAccounts(groupId);
    const unusedAccounts = allAccounts.filter((entry) => entry.status === 'unused');

    if (unusedAccounts.length > 0) {
      this.logger.log(
        `[UserPool] 轮换提示: 有 ${unusedAccounts.length} 个未使用的账号可用, ` +
        '下次查询将自动切换到使用次数最少的账号',
      );
    }
  }

  /**
   * @description 清理账号登录会话的共享 Redis 状态.
   *
   * 主服务不再通过 SessionManager 执行或管理 Apple 登录生命周期, 这里只删除
   * 账号池可见的 managed session 元数据和 cookie key, 使后续查询不会继续选中旧 session。
   *
   * @param sessionId managed session ID
   * @param emailKey 小写 Apple ID 邮箱
   * @sideEffects 删除 Redis 中的 managed session、cookies 和 email→session 映射
   */
  private async cleanupManagedSessionState(sessionId: string, emailKey: string): Promise<void> {
    await this.redisService.del(
      CACHE_KEYS.MANAGED_SESSION.build(sessionId),
      CACHE_KEYS.MANAGED_SESSION_COOKIES.build(sessionId),
      CACHE_KEYS.EMAIL_TO_SESSION.build(emailKey),
    );
  }
}
