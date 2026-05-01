import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AccountSessionInitializerService } from '../account-session-initializer/account-session-initializer.service';
import { HIGH_FREQUENCY_REGION_PATHS } from '../../constants/apple-storefront.constants';
import { DistributedCacheService, DistributedLockService, LockHandle } from '../distributed-cache';
import { UserAccountPoolIdentityService } from '../user-account-pool-core/user-account-pool-identity.service';

/** 登录后预热的最大并发数 — 有代理控制出口, 可适当提高 */
const LOGIN_WARMUP_CONCURRENCY = 5;
/** 按需补齐地区预热池的最大并发数 — 避免实时请求触发过多后台初始化 */
const ON_DEMAND_WARMUP_CONCURRENCY = 2;
/** 地区首次被检测到时, 后台至少补齐的 ready session 数量 */
const ON_DEMAND_WARMUP_TARGET = 3;
/** 账号预热重分配锁 TTL (毫秒) — 覆盖后台 login+init, 防止多 Pod 同时清理同一账号地区索引 */
const WARMUP_ACCOUNT_LOCK_TTL_MS = 10 * 60 * 1000;
/** session 修复锁 TTL (毫秒) — 覆盖后台 login+init, 防止多 Pod 重复修复同一缓存 */
const SESSION_REPAIR_LOCK_TTL_MS = 10 * 60 * 1000;
/** 高频地区默认预热容量 — 可通过 ACCOUNT_SESSION_WARMUP_TARGETS 覆盖 */
const DEFAULT_WARMUP_TARGETS: Record<string, number> = {
  '/us': 8,
  '/jp': 5,
  '/cn': 4,
  '/kr': 3,
  '/sg': 3,
  '/hk': 3,
  '/tw': 3,
  '/au': 2,
  '/ca': 2,
  '/de': 2,
  '/fr': 2,
  '/it': 1,
  '/es': 1,
  '/br': 1,
};

type WarmupAccount = { email: string; password: string; accountKey?: string; groupId?: number | null };
type GroupWarmupCapacityResult = { groupId: number | null; accountCount: number; regionCount: number };

/**
 * @description 账号查询 session 预热服务.
 *
 * 该服务只负责预热任务的分配、限流、账号锁和事件监听; Apple 登录/初始化
 * 的底层实现委托给 AccountSessionInitializerService.initializeQuerySession()。
 */
@Injectable()
export class AccountSessionWarmupService {
  private readonly logger = new Logger(AccountSessionWarmupService.name);

  /**
   * @description 注入预热编排依赖.
   * @param accountSessionInitializer 账号上下文初始化服务, 提供 session 初始化能力
   * @param cacheService Redis 分布式缓存服务
   * @param lockService Redis 分布式锁服务
   * @param identityService 用户组内账号身份 key 生成服务
   */
  constructor(
    private readonly accountSessionInitializer: AccountSessionInitializerService,
    private readonly cacheService: DistributedCacheService,
    private readonly lockService: DistributedLockService,
    private readonly identityService: UserAccountPoolIdentityService,
  ) { }

  /**
   * @description 异步修复失效的 account+region session.
   *
   * 修复任务与业务请求解耦: 当前请求切换到其他 ready session,
   * 失效账号在后台重新执行 login+init 并写回 Redis 预热索引。
   *
   * @param cacheKey 账号+地区缓存 key
   * @param regionPath 地区路径
   * @param accounts 账号列表, 首个账号为待修复账号
   * @param reason 调度原因, 用于日志
   * @sideEffects 后台写入 Redis session、预热索引和账号地区绑定
   */
  scheduleSessionRepair(
    cacheKey: string,
    regionPath: string,
    accounts: WarmupAccount[],
    reason: string,
  ): void {
    setImmediate(() => {
      this.repairSessionInBackground(cacheKey, regionPath, accounts, reason)
        .catch((error: any) => {
          this.logger.warn(`[cache-repair] 修复异常: key=${cacheKey}, error=${error.message}`);
        });
    });
  }

  /**
   * @description 按用户组补齐配置内高频地区的 ready session 容量.
   *
   * 该方法供主动刷新调度器调用: 只读取当前用户组 active 账号, 再复用
   * ensureRegionWarmupCapacity 的候选筛选、锁和初始化逻辑。若当前 warm pool 已满足
   * 目标容量, 不会触发新的 Apple login/init。
   *
   * @param groupId 用户组 ID; null 表示历史/全局资源池
   * @param reason 调度原因, 用于日志定位
   * @returns 本轮扫描的账号数和地区数
   * @sideEffects 可能后台执行查询上下文初始化并写入 Redis session
   */
  async ensureGroupWarmupCapacity(
    groupId: number | null,
    reason: string,
  ): Promise<GroupWarmupCapacityResult> {
    const accounts = await this.buildWarmupAccountsForGroup(groupId);
    if (accounts.length === 0) {
      this.logger.debug(`[warmup-active] 用户组无 active 账号, 跳过: groupId=${groupId ?? 'global'}, reason=${reason}`);
      return { groupId, accountCount: 0, regionCount: 0 };
    }

    const warmupTargets = this.getWarmupTargets();
    for (const [regionPath, targetCount] of warmupTargets) {
      await this.ensureRegionWarmupCapacity(regionPath, accounts, Math.min(targetCount, accounts.length));
    }

    this.logger.log(
      `[warmup-active] 用户组刷新检查完成: groupId=${groupId ?? 'global'}, ` +
      `accounts=${accounts.length}, regions=${warmupTargets.size}, reason=${reason}`,
    );

    return { groupId, accountCount: accounts.length, regionCount: warmupTargets.size };
  }

  /**
   * @description 后台补齐指定地区的 ready session 容量.
   *
   * 该方法用于未知地区卡首次检测出地区后, 异步为后续同地区请求补充 session。
   * 它不会阻塞当前请求, 也只会选择未绑定或已绑定同地区的空闲账号, 避免破坏其它地区热缓存.
   *
   * @param regionPath 目标地区路径
   * @param accounts 可用账号凭据列表
   * @param targetReady 目标 ready session 数量
   * @sideEffects 后台执行 login+init 并写入 Redis session/预热索引
   */
  async ensureRegionWarmupCapacity(
    regionPath: string,
    accounts: WarmupAccount[],
    targetReady: number = ON_DEMAND_WARMUP_TARGET,
  ): Promise<void> {
    if (!regionPath || accounts.length === 0 || targetReady <= 0) {
      return;
    }

    const targetCount = Math.min(targetReady, accounts.length);
    const candidateIdentitySet = new Set(
      accounts.map((account) => (account.accountKey || account.email.toLowerCase()).toLowerCase()),
    );
    const warmedEmails = await this.cacheService.getWarmedAccounts(regionPath);
    const warmedSessionKeys = warmedEmails.map((email) => `${email.toLowerCase()}:${regionPath}`);
    const warmedSessionStates = await this.cacheService.batchHasSession(warmedSessionKeys);
    const readyWarmedEmails = warmedEmails.filter((accountIdentity, index) => {
      return warmedSessionStates[index] && candidateIdentitySet.has(accountIdentity.toLowerCase());
    });

    if (readyWarmedEmails.length >= targetCount) {
      return;
    }

    const warmedSet = new Set(readyWarmedEmails.map((accountIdentity) => accountIdentity.toLowerCase()));
    const emails = accounts.map((account) => account.accountKey || account.email.toLowerCase());
    const cacheKeys = accounts.map((account) => `${account.accountKey || account.email.toLowerCase()}:${regionPath}`);
    const [cooldowns, locks, boundRegions, sessionStates] = await Promise.all([
      this.cacheService.batchIsCoolingDown(cacheKeys),
      this.cacheService.batchIsLocked(cacheKeys),
      this.cacheService.batchGetAccountRegions(emails),
      this.cacheService.batchHasSession(cacheKeys),
    ]);

    const candidates = accounts.filter((account, index) => {
      const accountIdentity = (account.accountKey || account.email.toLowerCase()).toLowerCase();
      const boundRegion = boundRegions[index];

      if (warmedSet.has(accountIdentity)) return false;
      if (sessionStates[index]) return false;
      if (cooldowns[index] || locks[index]) return false;
      return !boundRegion || boundRegion === regionPath;
    });

    const missingCount = targetCount - readyWarmedEmails.length;
    const selected = candidates.slice(0, missingCount);
    if (selected.length === 0) {
      return;
    }

    this.logger.log(
      `[warmup-demand] 补齐地区预热池: region=${regionPath}, ` +
      `current=${readyWarmedEmails.length}, target=${targetCount}, tasks=${selected.length}`,
    );

    await this.executeWithConcurrencyLimit(
      selected,
      ON_DEMAND_WARMUP_CONCURRENCY,
      async (account) => {
        const accountLock = await this.lockService.tryAcquire(
          this.buildWarmupAccountLockKey(account.accountKey || account.email),
          WARMUP_ACCOUNT_LOCK_TTL_MS,
        );

        if (!accountLock) {
          this.logger.debug(
            `[warmup-demand] 账号正在其他 Pod 预热, 跳过: ` +
            `region=${regionPath}, account=${account.email.substring(0, 6)}***`,
          );
          return;
        }

        const cacheKey = `${account.accountKey || account.email.toLowerCase()}:${regionPath}`;
        try {
          await this.accountSessionInitializer.initializeQuerySession(cacheKey, regionPath, [account]);
        } catch (error: any) {
          this.logger.warn(
            `[warmup-demand] 预热失败: region=${regionPath}, ` +
            `account=${account.email.substring(0, 6)}*** — ${error.message}`,
          );
        } finally {
          await accountLock.release();
        }
      },
    );
  }

  /**
   * @description 监听批量登录完成事件 — 按「一账号一地区」原则异步预热 session.
   *
   * @param payload 事件数据: { accounts, warmupRegions?, jobId?, groupId? }
   * @sideEffects 异步初始化查询 session 并更新登录预热任务进度
   */
  @OnEvent('batch-login.completed', { async: true })
  async handleBatchLoginCompleted(
    payload: {
      accounts: WarmupAccount[];
      warmupRegions?: string[];
      jobId?: string;
      groupId?: number | null;
    },
  ): Promise<void> {
    const { accounts } = payload;
    if (!accounts || accounts.length === 0) return;

    this.logger.log(`[login-warmup] 🔥 收到批量登录完成事件`);

    const requestedWarmupRegions = this.normalizeRequestedWarmupRegions(payload.warmupRegions);
    const warmupTargets = requestedWarmupRegions.length > 0
      ? this.buildEvenWarmupTargets(accounts.length, requestedWarmupRegions)
      : this.getWarmupTargets();
    const warmupRegionSlots = await this.buildWarmupRegionSlots(accounts, warmupTargets);

    if (warmupRegionSlots.length === 0) {
      this.logger.log('[login-warmup] 高频地区预热容量已满足, 跳过预热');
      await this.markWarmupJobEmpty(payload.jobId);
      return;
    }

    const warmupTasks: Array<{
      regionPath: string;
      cacheKey: string;
      orderedAccounts: WarmupAccount[];
      accountLock: LockHandle;
    }> = [];

    for (let idx = 0; idx < accounts.length; idx++) {
      const primaryAccount = accounts[idx];
      const primaryAccountKey = primaryAccount.accountKey || primaryAccount.email.toLowerCase();
      const accountLock = await this.lockService.tryAcquire(
        this.buildWarmupAccountLockKey(primaryAccountKey),
        WARMUP_ACCOUNT_LOCK_TTL_MS,
      );

      if (!accountLock) {
        this.logger.debug(
          `[login-warmup] 账号正在其他 Pod 预热, 跳过: ` +
          `account=${primaryAccount.email.substring(0, 6)}***`,
        );
        continue;
      }

      const assignment = await this.findAssignableWarmupRegion(primaryAccountKey, warmupRegionSlots);
      if (!assignment) {
        this.logger.warn(
          `[login-warmup] 账号 ${primaryAccount.email.substring(0, 6)}*** 无可用地区 (全部已被其他预热占用)`,
        );
        await accountLock.release();
        continue;
      }

      const cleanupRegionPaths = Array.from(new Set([
        ...HIGH_FREQUENCY_REGION_PATHS,
        ...warmupTargets.keys(),
        assignment.regionPath,
      ]));

      try {
        await this.cleanupAccountRegionBindings(primaryAccountKey, cleanupRegionPaths);
      } catch (cleanupError: any) {
        await accountLock.release();
        this.logger.warn(
          `[login-warmup] 清理旧地区关联失败, 跳过账号: ` +
          `account=${primaryAccount.email.substring(0, 6)}*** — ${cleanupError.message}`,
        );
        continue;
      }

      warmupRegionSlots.splice(assignment.slotIndex, 1);
      warmupTasks.push({
        regionPath: assignment.regionPath,
        cacheKey: `${primaryAccountKey}:${assignment.regionPath}`,
        orderedAccounts: [
          primaryAccount,
          ...accounts.filter((_, accountIndex) => accountIndex !== idx),
        ],
        accountLock,
      });
    }

    if (warmupTasks.length === 0) {
      this.logger.log('[login-warmup] 无可分配的预热任务, 跳过');
      await this.markWarmupJobEmpty(payload.jobId);
      return;
    }

    await this.markWarmupJobStarted(payload.jobId, warmupTasks.length);

    await this.executeWithConcurrencyLimit(
      warmupTasks,
      LOGIN_WARMUP_CONCURRENCY,
      async (task) => {
        try {
          const success = await this.accountSessionInitializer.initializeQuerySession(
            task.cacheKey,
            task.regionPath,
            task.orderedAccounts,
          );
          await this.incrementWarmupJob(payload.jobId, success);
        } catch (error: any) {
          await this.incrementWarmupJob(payload.jobId, false);
          this.logger.warn(
            `[login-warmup] ⚠️ 预热失败: region=${task.regionPath} — ${error.message}`,
          );
        } finally {
          await task.accountLock.release();
        }
      },
    );
  }

  /**
   * @description 构建账号级预热锁 key.
   * @param accountIdentity Apple ID 邮箱或账号身份 key
   * @returns Redis 分布式锁业务 key
   */
  private buildWarmupAccountLockKey(accountIdentity: string): string {
    return `warmup-account:${accountIdentity.toLowerCase()}`;
  }

  /**
   * @description 读取用户组内可用于查询上下文预热的 active 账号.
   * @param groupId 用户组 ID; null 表示历史/全局资源池
   * @returns 预热账号凭据列表, accountKey 与账号池身份规则保持一致
   */
  private async buildWarmupAccountsForGroup(groupId: number | null): Promise<WarmupAccount[]> {
    const accounts = await this.cacheService.getAllAccounts(groupId);
    return accounts
      .filter((account) => account.status === 'active' && Boolean(account.password))
      .map((account) => ({
        email: account.email,
        password: account.password,
        groupId: account.groupId ?? groupId,
        accountKey: this.identityService.buildAccountIdentity(account.email, account.groupId ?? groupId),
      }));
  }

  /**
   * @description 后台执行 account+region session 修复.
   * @param cacheKey 账号+地区缓存 key
   * @param regionPath 地区路径
   * @param accounts 账号列表
   * @param reason 调度原因
   * @sideEffects 可能重新建立查询 session 并写入 Redis
   */
  private async repairSessionInBackground(
    cacheKey: string,
    regionPath: string,
    accounts: WarmupAccount[],
    reason: string,
  ): Promise<void> {
    const repairLock = await this.lockService.tryAcquire(`repair:${cacheKey}`, SESSION_REPAIR_LOCK_TTL_MS);
    if (!repairLock) {
      return;
    }

    try {
      this.logger.log(`[cache-repair] 开始修复: key=${cacheKey}, reason=${reason}`);
      const success = await this.accountSessionInitializer.initializeQuerySession(cacheKey, regionPath, accounts);
      if (success) {
        this.logger.log(`[cache-repair] 修复完成: key=${cacheKey}`);
      }
    } finally {
      await repairLock.release();
    }
  }

  /**
   * @description 解析地区预热目标容量.
   * @returns 地区路径到目标 ready session 数量的映射
   */
  private getWarmupTargets(): Map<string, number> {
    const configured = (
      process.env.ACCOUNT_SESSION_WARMUP_TARGETS ||
      process.env.GIFTCARD_WARMUP_TARGETS ||
      ''
    ).trim();
    const targets = new Map<string, number>();
    const source = configured || Object.entries(DEFAULT_WARMUP_TARGETS)
      .map(([regionPath, count]) => `${regionPath}:${count}`)
      .join(',');

    for (const item of source.split(',')) {
      const [rawRegion, rawCount] = item.split(':');
      const regionPath = rawRegion?.trim();
      const count = Number.parseInt(rawCount?.trim() || '', 10);

      if (!regionPath || !regionPath.startsWith('/') || !Number.isFinite(count) || count <= 0) {
        continue;
      }

      targets.set(regionPath, count);
    }

    return targets;
  }

  /**
   * @description 按目标容量构建预热槽位列表.
   * @param accounts 当前可用于预热的账号
   * @param targets 地区目标容量
   * @returns 待分配的地区槽位列表
   */
  private async buildWarmupRegionSlots(
    accounts: WarmupAccount[],
    targets: Map<string, number>,
  ): Promise<string[]> {
    const slots: string[] = [];

    for (const [regionPath, targetCount] of targets) {
      const keys = accounts.map((acc) => `${acc.accountKey || acc.email.toLowerCase()}:${regionPath}`);
      const cacheStates = await this.cacheService.batchHasSession(keys);
      const existingCount = cacheStates.filter((exists) => exists).length;
      const missingCount = Math.max(targetCount - existingCount, 0);

      for (let i = 0; i < missingCount; i++) {
        slots.push(regionPath);
      }
    }

    return slots;
  }

  /**
   * @description 标准化客户端提交的预热地区路径.
   * @param regions 客户端提交的地区路径列表
   * @returns 标准化后的地区路径列表
   */
  private normalizeRequestedWarmupRegions(regions?: string[]): string[] {
    if (!Array.isArray(regions)) return [];

    const seen = new Set<string>();
    const normalizedRegions: string[] = [];
    for (const region of regions) {
      const rawRegion = String(region || '').trim().toLowerCase();
      if (!rawRegion) continue;

      const regionPath = rawRegion.startsWith('/') ? rawRegion : `/${rawRegion}`;
      if (!/^\/[a-z]{2}$/.test(regionPath) || seen.has(regionPath)) {
        continue;
      }

      seen.add(regionPath);
      normalizedRegions.push(regionPath);
    }

    return normalizedRegions;
  }

  /**
   * @description 按账号数量平均生成指定预热地区的目标容量.
   * @param accountCount 可用于预热的账号数量
   * @param regionPaths 指定的预热地区路径
   * @returns 地区路径到目标 ready session 数量的映射
   */
  private buildEvenWarmupTargets(
    accountCount: number,
    regionPaths: string[],
  ): Map<string, number> {
    const targets = new Map<string, number>();
    if (accountCount <= 0 || regionPaths.length === 0) {
      return targets;
    }

    for (let idx = 0; idx < accountCount; idx++) {
      const regionPath = regionPaths[idx % regionPaths.length];
      targets.set(regionPath, (targets.get(regionPath) || 0) + 1);
    }

    return targets;
  }

  /**
   * @description 查找当前账号可分配的预热地区.
   * @param primaryAccountKey 当前账号身份 key
   * @param warmupRegionSlots 待分配地区槽位
   * @returns 地区和槽位下标; 无可分配地区时返回 null
   */
  private async findAssignableWarmupRegion(
    primaryAccountKey: string,
    warmupRegionSlots: string[],
  ): Promise<{ regionPath: string; slotIndex: number } | null> {
    for (let slotIndex = 0; slotIndex < warmupRegionSlots.length; slotIndex++) {
      const regionPath = warmupRegionSlots[slotIndex];
      const cacheKey = `${primaryAccountKey}:${regionPath}`;
      const [hasSession] = await this.cacheService.batchHasSession([cacheKey]);
      if (!hasSession) {
        return { regionPath, slotIndex };
      }
    }

    return null;
  }

  /**
   * @description 清理账号在指定地区集合中的旧 session 和绑定.
   * @param accountKey 账号身份 key
   * @param regionPaths 需要清理的地区路径
   * @sideEffects 删除旧 session、预热集合成员和账号地区绑定
   */
  private async cleanupAccountRegionBindings(accountKey: string, regionPaths: string[]): Promise<void> {
    const allKeys = regionPaths.map((regionPath) => `${accountKey}:${regionPath}`);
    await this.cacheService.batchEvictSessions(allKeys);
    await Promise.all([
      ...regionPaths.map((regionPath) =>
        this.cacheService.removeWarmedAccountMember(regionPath, accountKey),
      ),
      this.cacheService.deleteAccountRegion(accountKey),
    ]);
  }

  /**
   * @description 标记预热任务为空任务.
   * @param jobId 可选登录预热任务 ID
   * @sideEffects 更新 Redis 中的任务进度
   */
  private async markWarmupJobEmpty(jobId?: string): Promise<void> {
    if (!jobId) return;

    await this.cacheService.updateLoginWarmupJob(jobId, {
      status: 'warming',
      phase: 'warming',
      warmupTotal: 0,
      warmupFinished: 0,
    });
  }

  /**
   * @description 标记预热任务开始.
   * @param jobId 可选登录预热任务 ID
   * @param total 任务总数
   * @sideEffects 更新 Redis 中的任务进度
   */
  private async markWarmupJobStarted(jobId: string | undefined, total: number): Promise<void> {
    if (!jobId) return;

    await this.cacheService.updateLoginWarmupJob(jobId, {
      status: 'warming',
      phase: 'warming',
      warmupTotal: total,
      warmupFinished: 0,
      warmupSuccess: 0,
      warmupFailed: 0,
    });
  }

  /**
   * @description 累加单个预热任务结果.
   * @param jobId 可选登录预热任务 ID
   * @param success 当前任务是否成功
   * @sideEffects 更新 Redis 中的任务进度计数
   */
  private async incrementWarmupJob(jobId: string | undefined, success: boolean): Promise<void> {
    if (!jobId) return;

    await this.cacheService.incrementLoginWarmupJob(jobId, {
      warmupFinished: 1,
      warmupSuccess: success ? 1 : 0,
      warmupFailed: success ? 0 : 1,
    });
  }

  /**
   * @description 带并发度限制的批量任务执行器.
   * @param items 待执行的任务列表
   * @param concurrency 最大并发数
   * @param handler 单个任务的执行函数
   */
  private async executeWithConcurrencyLimit<T>(
    items: T[],
    concurrency: number,
    handler: (item: T) => Promise<void>,
  ): Promise<void> {
    const executing = new Set<Promise<void>>();

    for (const item of items) {
      const task = handler(item).then(() => {
        executing.delete(task);
      });
      executing.add(task);

      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);
  }
}
