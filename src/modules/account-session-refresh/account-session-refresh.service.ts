import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AccountSessionWarmupService } from '../account-session-warmup/account-session-warmup.service';
import { DistributedCacheService, DistributedLockService, LockHandle, SerializedGroupActivity } from '../distributed-cache';
import { UserAccountPoolLoginService } from '../user-account-pool-login/user-account-pool-login.service';

/** 默认活跃组扫描间隔: 5 分钟. */
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** 默认业务空闲窗口: 60 分钟未使用即停止无感刷新. */
const DEFAULT_ACTIVE_IDLE_MS = 60 * 60 * 1000;
/** 默认首次扫描延迟: 避免服务启动时与登录消费者抢初始化资源. */
const DEFAULT_INITIAL_DELAY_MS = 30 * 1000;
/** 默认 managed login session 提前刷新窗口: 剩余 2 小时内触发后台 relogin. */
const DEFAULT_LOGIN_RENEW_BEFORE_SECONDS = 2 * 60 * 60;
/** 默认单轮最多调度的登录刷新账号数. */
const DEFAULT_LOGIN_REFRESH_LIMIT = 10;

/**
 * @description 账号查询 session 无感刷新调度器.
 *
 * RosettaX 主服务在 GiftCardChecker/GiftCardExchanger 入口写入用户组活跃心跳;
 * 本服务按固定间隔扫描仍处于活跃窗口内的用户组, 并调用 AccountSessionWarmupService
 * 补齐配置中的高频地区 warm pool。业务空闲超过窗口后不会再触发刷新。
 */
@Injectable()
export class AccountSessionRefreshService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AccountSessionRefreshService.name);

  private readonly enabled = this.parseBooleanEnv('ACCOUNT_SESSION_ACTIVE_REFRESH_ENABLED', true);
  private readonly refreshIntervalMs = this.parsePositiveIntEnv(
    'ACCOUNT_SESSION_ACTIVE_REFRESH_INTERVAL_MS',
    DEFAULT_REFRESH_INTERVAL_MS,
  );
  private readonly activeIdleMs = this.parsePositiveIntEnv(
    'ACCOUNT_SESSION_ACTIVE_IDLE_MS',
    DEFAULT_ACTIVE_IDLE_MS,
  );
  private readonly initialDelayMs = this.parsePositiveIntEnv(
    'ACCOUNT_SESSION_ACTIVE_REFRESH_INITIAL_DELAY_MS',
    DEFAULT_INITIAL_DELAY_MS,
  );
  private readonly lockTtlMs = this.parsePositiveIntEnv(
    'ACCOUNT_SESSION_ACTIVE_REFRESH_LOCK_TTL_MS',
    Math.max(60_000, this.refreshIntervalMs - 5_000),
  );
  private readonly loginRefreshEnabled = this.parseBooleanEnv('ACCOUNT_SESSION_ACTIVE_LOGIN_REFRESH_ENABLED', true);
  private readonly loginRenewBeforeSeconds = this.parsePositiveIntEnv(
    'ACCOUNT_SESSION_ACTIVE_LOGIN_RENEW_BEFORE_SECONDS',
    DEFAULT_LOGIN_RENEW_BEFORE_SECONDS,
  );
  private readonly loginRefreshLimit = this.parsePositiveIntEnv(
    'ACCOUNT_SESSION_ACTIVE_LOGIN_REFRESH_LIMIT',
    DEFAULT_LOGIN_REFRESH_LIMIT,
  );

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /**
   * @description 注入无感刷新依赖.
   * @param cacheService Redis 缓存服务, 用于扫描业务活跃心跳
   * @param lockService 分布式锁服务, 防止多 Property Pod 重复刷新同一用户组
   * @param warmupService 查询上下文预热服务, 负责实际 warm pool 补齐
   * @param loginService 用户账号池登录服务, 负责 managed session 后台刷新
   */
  constructor(
    private readonly cacheService: DistributedCacheService,
    private readonly lockService: DistributedLockService,
    private readonly warmupService: AccountSessionWarmupService,
    private readonly loginService: UserAccountPoolLoginService,
  ) { }

  /**
   * @description Nest 启动钩子, 注册周期刷新任务.
   * @sideEffects 创建定时器并按配置扫描活跃用户组
   */
  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('[refresh-active] 已禁用主动无感刷新: ACCOUNT_SESSION_ACTIVE_REFRESH_ENABLED=false');
      return;
    }

    this.logger.log(
      `[refresh-active] 启动主动无感刷新: intervalMs=${this.refreshIntervalMs}, ` +
      `idleMs=${this.activeIdleMs}, initialDelayMs=${this.initialDelayMs}, lockTtlMs=${this.lockTtlMs}, ` +
      `loginRefresh=${this.loginRefreshEnabled}, loginRenewBeforeSeconds=${this.loginRenewBeforeSeconds}`,
    );

    this.initialTimer = setTimeout(() => {
      void this.refreshActiveGroups('initial');
    }, this.initialDelayMs);
    this.refreshTimer = setInterval(() => {
      void this.refreshActiveGroups('interval');
    }, this.refreshIntervalMs);
  }

  /**
   * @description Nest 销毁钩子, 清理定时器.
   * @sideEffects 停止后续活跃组扫描
   */
  onModuleDestroy(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * @description 扫描业务活跃用户组并补齐对应 warm pool.
   *
   * 同一进程内使用 running 防重入; 跨 Pod 使用 groupKey 级分布式锁,
   * 保证多实例部署时同一用户组同一轮只会有一个 Property Pod 负责刷新。
   *
   * @param reason 扫描原因, 用于日志
   * @sideEffects 可能触发账号查询上下文初始化并写入 Redis session
   */
  private async refreshActiveGroups(reason: string): Promise<void> {
    if (this.running) {
      this.logger.debug(`[refresh-active] 上一轮仍在执行, 跳过本轮: reason=${reason}`);
      return;
    }

    this.running = true;
    try {
      const activities = await this.cacheService.getActiveGroupActivities(this.activeIdleMs);
      if (activities.length === 0) {
        this.logger.debug(`[refresh-active] 当前无活跃用户组: reason=${reason}`);
        return;
      }

      this.logger.log(`[refresh-active] 扫描到活跃用户组: count=${activities.length}, reason=${reason}`);
      for (const activity of activities) {
        await this.refreshSingleGroup(activity, reason);
      }
    } catch (error: any) {
      this.logger.warn(`[refresh-active] 扫描异常: reason=${reason} — ${error.message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * @description 对单个活跃用户组执行 warm pool 容量检查.
   * @param activity 用户组活跃心跳快照
   * @param reason 当前扫描原因
   * @sideEffects 可能触发该用户组的查询上下文预热
   */
  private async refreshSingleGroup(activity: SerializedGroupActivity, reason: string): Promise<void> {
    let lock: LockHandle | null = null;
    const lockKey = `active-refresh:${activity.groupKey}`;

    try {
      lock = await this.lockService.tryAcquire(lockKey, this.lockTtlMs);
      if (!lock) {
        this.logger.debug(`[refresh-active] 用户组刷新锁已被持有, 跳过: group=${activity.groupKey}`);
        return;
      }

      if (this.loginRefreshEnabled) {
        await this.loginService.refreshExpiringManagedSessionsForGroup(
          activity.groupId,
          this.loginRenewBeforeSeconds,
          this.loginRefreshLimit,
        );
      }

      await this.warmupService.ensureGroupWarmupCapacity(
        activity.groupId,
        `${reason}:${activity.source}`,
      );
    } catch (error: any) {
      this.logger.warn(
        `[refresh-active] 用户组刷新失败: group=${activity.groupKey}, ` +
        `lastSeenAt=${activity.lastSeenAt}, source=${activity.source} — ${error.message}`,
      );
    } finally {
      if (lock) {
        await lock.release();
      }
    }
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
   * @description 解析布尔环境变量.
   * @param key 环境变量名
   * @param fallback 默认值
   * @returns 布尔配置值
   */
  private parseBooleanEnv(key: string, fallback: boolean): boolean {
    const value = String(process.env[key] || '').trim().toLowerCase();
    if (!value) return fallback;
    return !['0', 'false', 'no', 'off'].includes(value);
  }
}
