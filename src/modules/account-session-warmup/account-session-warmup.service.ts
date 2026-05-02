import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AccountSessionInitializerService,
  QuerySessionInitializationResult,
} from '../account-session-initializer/account-session-initializer.service';
import {
  AppleInitializationLimiterService,
  AppleInitializationPriority,
} from '../apple-initialization-limiter/apple-initialization-limiter.service';
import { HIGH_FREQUENCY_REGION_PATHS } from '../../constants/apple-storefront.constants';
import { DistributedCacheService, SerializedPoolEntry } from '../distributed-cache';
import { UserAccountPoolIdentityService } from '../user-account-pool-core/user-account-pool-identity.service';
import { AppleAccount } from '../../entities/apple-account.entity';
import { GroupWarmUpRecord } from '../../entities/group_warm_up_record.entity';

/**
 * @description 解析正整数环境变量.
 * @param key 环境变量名
 * @param fallback 默认值
 * @returns 合法正整数或默认值
 */
function parsePositiveIntEnv(key: string, fallback: number): number {
  const value = Number.parseInt(process.env[key] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 登录后预热的最大并发数 — 有代理控制出口, 可通过环境变量调节. */
const LOGIN_WARMUP_CONCURRENCY = parsePositiveIntEnv('ROSETTAX_PROPERTY_LOGIN_WARMUP_CONCURRENCY', 5);
/** 按需补齐地区预热池的最大并发数 — 避免实时请求触发过多后台初始化. */
const ON_DEMAND_WARMUP_CONCURRENCY = parsePositiveIntEnv('ROSETTAX_PROPERTY_ON_DEMAND_WARMUP_CONCURRENCY', 2);
/** 地区首次被检测到时, 后台至少补齐的 ready session 数量. */
const ON_DEMAND_WARMUP_TARGET = parsePositiveIntEnv('ROSETTAX_PROPERTY_ON_DEMAND_WARMUP_TARGET', 3);
/** 热门地区缺账号时每次追加的 ready session 数量. */
const MISSING_QUERY_ACCOUNT_REGION_INCREMENT = parsePositiveIntEnv('ROSETTAX_PROPERTY_MISSING_REGION_INCREMENT', 10);
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
type GroupWarmupCapacityResult = {
  groupId: number | null;
  accountCount: number;
  regionCount: number;
  regionPath?: string;
  readyBefore?: number;
  targetReady?: number;
};
type RegionWarmupCandidate = {
  account: WarmupAccount;
  accountKey: string;
  boundRegion: string | null;
  requiresMigration: boolean;
};

/**
 * @description 单账号单地区预热计划.
 */
export interface PlannedAccountWarmupTask {
  /** 目标地区路径, 如 /us */
  regionPath: string;
  /** 查询 session cacheKey, 格式为 accountKey:regionPath */
  cacheKey: string;
  /** 主账号凭据 */
  account: {
    email: string;
    password: string;
    accountKey: string;
    groupId: number | null;
  };
  /** 执行预热前需要清理的旧地区绑定 */
  cleanupRegionPaths: string[];
}

/**
 * @description 账号查询 session 预热服务.
 *
 * 该服务只负责预热任务分配和并发控制; Apple 登录/初始化由
 * AccountSessionInitializerService.initializeQuerySession() 完成。
 */
@Injectable()
export class AccountSessionWarmupService {
  private readonly logger = new Logger(AccountSessionWarmupService.name);

  /**
   * @description 注入预热编排依赖.
   * @param accountSessionInitializer 账号上下文初始化服务, 提供 session 初始化能力
   * @param initializationLimiter Apple 初始化跨 Pod 全局并发限制器
   * @param cacheService Redis 分布式缓存服务
   * @param identityService 用户组内账号身份 key 生成服务
   * @param appleAccountRepo Apple 账号 DB 仓储
   * @param warmupRecordRepo 用户组预热地区 DB 仓储
   */
  constructor(
    private readonly accountSessionInitializer: AccountSessionInitializerService,
    private readonly initializationLimiter: AppleInitializationLimiterService,
    private readonly cacheService: DistributedCacheService,
    private readonly identityService: UserAccountPoolIdentityService,
    @InjectRepository(AppleAccount)
    private readonly appleAccountRepo: Repository<AppleAccount>,
    @InjectRepository(GroupWarmUpRecord)
    private readonly warmupRecordRepo: Repository<GroupWarmUpRecord>,
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
   * 该方法供主动刷新调度器调用: 只读取当前用户组 active 账号并补齐缺口。
   *
   * @param groupId 用户组 ID; null 表示历史/全局资源池
   * @param reason 调度原因, 用于日志定位
   * @param requestedRegion 当前业务缺失地区, 仅用于日志定位
   * @returns 本轮扫描的账号数和地区数
   * @sideEffects 可能后台执行查询上下文初始化并写入 Redis session
   */
  async ensureGroupWarmupCapacity(
    groupId: number | null,
    reason: string,
    requestedRegion?: string,
  ): Promise<GroupWarmupCapacityResult> {
    const accounts = await this.buildWarmupAccountsForGroup(groupId);
    if (accounts.length === 0) {
      this.logger.debug(`[warmup-active] 用户组无 active 账号, 跳过: groupId=${groupId ?? 'global'}, reason=${reason}`);
      return { groupId, accountCount: 0, regionCount: 0 };
    }

    const configuredRegions = await this.getConfiguredWarmupRegions(groupId);
    if (configuredRegions.length === 0) {
      this.logger.warn(
        `[warmup-active] 用户组未配置预热地区, 跳过: ` +
        `groupId=${groupId ?? 'global'}, requestedRegion=${requestedRegion || '(none)'}`,
      );
      return { groupId, accountCount: accounts.length, regionCount: 0 };
    }

    const requestedRegionPath = this.normalizeSingleRegionPath(requestedRegion);
    if (requestedRegionPath && !configuredRegions.includes(requestedRegionPath)) {
      this.logger.log(
        `[warmup-active] 按需补齐运行时缺失地区: ` +
        `groupId=${groupId ?? 'global'}, region=${requestedRegionPath}, reason=${reason}`,
      );
      await this.ensureRegionWarmupCapacity(requestedRegionPath, accounts, ON_DEMAND_WARMUP_TARGET, true);
    }

    const warmupTargets = this.buildEvenWarmupTargets(accounts.length, configuredRegions);
    for (const [regionPath, targetCount] of warmupTargets) {
      await this.ensureRegionWarmupCapacity(regionPath, accounts, Math.min(targetCount, accounts.length));
    }

    return {
      groupId,
      accountCount: accounts.length,
      regionCount: warmupTargets.size + (requestedRegionPath && !configuredRegions.includes(requestedRegionPath) ? 1 : 0),
    };
  }

  /**
   * @description 为指定热门地区追加 ready 查询 session 容量.
   *
   * 该入口只服务于 `missing query account` 场景: 如果某地区已经补过一批仍然
   * 不够用, 下一次继续在现有 ready 数量上追加固定增量, 并允许从其他地区迁移
   * 账号, 让实际流量驱动资源向热门地区倾斜。
   *
   * @param groupId 用户组 ID; null 表示历史/全局资源池
   * @param requestedRegion 缺少账号的地区路径
   * @param reason 调度原因, 用于日志定位
   * @param increment 本轮追加的 ready session 数量
   * @returns 本轮扫描的账号数、地区数和目标容量
   * @sideEffects 可能迁移账号地区绑定并写入 Redis 查询 session
   */
  async ensureAdditionalRegionWarmupCapacity(
    groupId: number | null,
    requestedRegion: string,
    reason: string,
    increment: number = MISSING_QUERY_ACCOUNT_REGION_INCREMENT,
  ): Promise<GroupWarmupCapacityResult> {
    const regionPath = this.normalizeSingleRegionPath(requestedRegion);
    const accounts = await this.buildWarmupAccountsForGroup(groupId);
    if (!regionPath || accounts.length === 0) {
      return { groupId, accountCount: accounts.length, regionCount: regionPath ? 1 : 0 };
    }

    const readyBefore = (await this.getReadyWarmedAccountKeys(regionPath, accounts)).length;
    const targetReady = Math.min(accounts.length, readyBefore + Math.max(1, increment));
    this.logger.log(
      `[warmup-hot-region] 追加地区容量: groupId=${groupId ?? 'global'}, ` +
      `region=${regionPath}, ready=${readyBefore}, target=${targetReady}, reason=${reason}`,
    );

    if (targetReady > readyBefore) {
      await this.ensureRegionWarmupCapacity(regionPath, accounts, targetReady, true);
    }

    return {
      groupId,
      accountCount: accounts.length,
      regionCount: 1,
      regionPath,
      readyBefore,
      targetReady,
    };
  }

  /**
   * @description 直接重建指定账号在指定地区的查询上下文.
   *
   * 该入口服务于实时查询链路的明确失效/轮换信号: 当 RosettaX 已经确认某个
   * account+region 的 initContext 上下文达到使用上限或命中风控, Property 必须
   * 重建同一个账号的上下文, 而不是只做用户组容量兜底。
   *
   * @param groupId 用户组 ID
   * @param requestedRegion 需要重建的地区路径
   * @param account 需要重建上下文的账号凭据
   * @param reason 调度原因
   * @sideEffects 清理旧上下文并执行 login/initContext, 成功后写入 Redis session
   */
  async rebuildRequestedAccountSession(
    groupId: number | null,
    requestedRegion: string,
    account: WarmupAccount,
    reason: string,
  ): Promise<boolean> {
    const regionPath = this.normalizeSingleRegionPath(requestedRegion);
    if (!regionPath || !account.email || !account.password) {
      this.logger.warn(
        `[cache-repair] 指定账号重建参数无效: ` +
        `groupId=${groupId ?? 'global'}, region=${requestedRegion || '(empty)'}, reason=${reason}`,
      );
      return false;
    }

    const email = account.email.toLowerCase();
    const accountKey = account.accountKey || this.identityService.buildAccountIdentity(email, groupId);
    const [boundRegion] = await this.cacheService.batchGetAccountRegions([accountKey]);
    const configuredRegions = await this.getConfiguredWarmupRegions(groupId);
    const cleanupRegionPaths = Array.from(new Set([
      ...HIGH_FREQUENCY_REGION_PATHS,
      ...configuredRegions,
      ...(boundRegion ? [boundRegion] : []),
      regionPath,
    ]));

    this.logger.log(
      `[cache-repair] 开始重建指定账号上下文: ` +
      `key=${accountKey}:${regionPath}, reason=${reason}`,
    );

    const success = await this.executePlannedWarmupTask(
      {
        regionPath,
        cacheKey: `${accountKey}:${regionPath}`,
        account: {
          email,
          password: account.password,
          accountKey,
          groupId,
        },
        cleanupRegionPaths,
      },
      'realtime',
    );

    if (success) {
      this.logger.log(`[cache-repair] 指定账号上下文重建完成: key=${accountKey}:${regionPath}`);
    } else {
      this.logger.warn(`[cache-repair] 指定账号上下文重建未成功: key=${accountKey}:${regionPath}, reason=${reason}`);
    }
    return success;
  }

  /**
   * @description 后台补齐指定地区的 ready session 容量.
   *
   * 该方法用于未知地区卡首次检测出地区后, 异步为后续同地区请求补充 session。
   * 默认只选择未绑定或已绑定同地区的空闲账号; 运行时按需地区可显式允许迁移,
   * 迁移前会清理旧地区上下文, 保持一个账号同一时刻只绑定一个预热地区。
   *
   * @param regionPath 目标地区路径
   * @param accounts 可用账号凭据列表
   * @param targetReady 目标 ready session 数量
   * @param allowMigration 是否允许从其它地区迁移账号补齐当前地区
   * @sideEffects 后台执行 login+init 并写入 Redis session/预热索引
   */
  async ensureRegionWarmupCapacity(
    regionPath: string,
    accounts: WarmupAccount[],
    targetReady: number = ON_DEMAND_WARMUP_TARGET,
    allowMigration: boolean = false,
  ): Promise<void> {
    if (!regionPath || accounts.length === 0 || targetReady <= 0) {
      return;
    }

    const targetCount = Math.min(targetReady, accounts.length);
    const readyWarmedEmails = await this.getReadyWarmedAccountKeys(regionPath, accounts);

    if (readyWarmedEmails.length >= targetCount) {
      return;
    }

    const warmedSet = new Set(readyWarmedEmails.map((accountIdentity) => accountIdentity.toLowerCase()));
    const emails = accounts.map((account) => (account.accountKey || account.email.toLowerCase()).toLowerCase());
    const cacheKeys = emails.map((accountKey) => `${accountKey}:${regionPath}`);
    const [cooldowns, locks, boundRegions, sessionStates] = await Promise.all([
      this.cacheService.batchIsCoolingDown(cacheKeys),
      this.cacheService.batchIsLocked(cacheKeys),
      this.cacheService.batchGetAccountRegions(emails),
      this.cacheService.batchHasSession(cacheKeys),
    ]);
    const boundCacheKeys = emails.map((accountKey, index) => {
      const boundRegion = boundRegions[index];
      return boundRegion && boundRegion !== regionPath ? `${accountKey}:${boundRegion}` : '';
    });
    const activeBoundCacheKeys = boundCacheKeys.filter(Boolean);
    const [boundCooldowns, boundLocks] = await Promise.all([
      this.cacheService.batchIsCoolingDown(activeBoundCacheKeys),
      this.cacheService.batchIsLocked(activeBoundCacheKeys),
    ]);
    const boundCooldownByKey = new Map(activeBoundCacheKeys.map((cacheKey, index) => [cacheKey, boundCooldowns[index]]));
    const boundLockByKey = new Map(activeBoundCacheKeys.map((cacheKey, index) => [cacheKey, boundLocks[index]]));

    const reusableCandidates: RegionWarmupCandidate[] = [];
    const migrationCandidates: RegionWarmupCandidate[] = [];
    accounts.forEach((account, index) => {
      const accountIdentity = (account.accountKey || account.email.toLowerCase()).toLowerCase();
      const boundRegion = boundRegions[index];
      const boundCacheKey = boundCacheKeys[index];

      if (warmedSet.has(accountIdentity)) return;
      if (sessionStates[index]) return;
      if (cooldowns[index] || locks[index]) return;
      if (boundCacheKey && (boundCooldownByKey.get(boundCacheKey) || boundLockByKey.get(boundCacheKey))) {
        return;
      }

      const candidate: RegionWarmupCandidate = {
        account,
        accountKey: accountIdentity,
        boundRegion,
        requiresMigration: Boolean(boundRegion && boundRegion !== regionPath),
      };

      if (candidate.requiresMigration) {
        migrationCandidates.push(candidate);
      } else {
        reusableCandidates.push(candidate);
      }
    });

    const missingCount = targetCount - readyWarmedEmails.length;
    const selected = [
      ...reusableCandidates,
      ...(allowMigration ? migrationCandidates : []),
    ].slice(0, missingCount);
    if (selected.length === 0) {
      this.logger.warn(
        `[warmup-demand] 无可用候选账号: region=${regionPath}, ` +
        `target=${targetCount}, ready=${readyWarmedEmails.length}, ` +
        `reusable=${reusableCandidates.length}, migration=${migrationCandidates.length}, ` +
        `allowMigration=${allowMigration}`,
      );
      return;
    }

    const migrationCount = selected.filter((candidate) => candidate.requiresMigration).length;
    this.logger.log(
      `[warmup-demand] 开始补齐地区: region=${regionPath}, missing=${missingCount}, ` +
      `selected=${selected.length}, migration=${migrationCount}, allowMigration=${allowMigration}`,
    );

    await this.executeWithConcurrencyLimit(
      selected,
      ON_DEMAND_WARMUP_CONCURRENCY,
      async (candidate) => {
        const cacheKey = `${candidate.accountKey}:${regionPath}`;
        try {
          if (candidate.requiresMigration) {
            await this.cleanupAccountRegionBindings(
              candidate.accountKey,
              this.buildOnDemandCleanupRegionPaths(regionPath, candidate.boundRegion),
            );
          }

          const result = await this.initializeAndRecordWarmupResult(
            cacheKey,
            regionPath,
            candidate.account,
            'background',
          );
          if (!result.success) {
            this.logger.warn(
              `[warmup-demand] 预热未成功: region=${regionPath}, ` +
              `account=${candidate.account.email.substring(0, 6)}***, ` +
              `reason=${this.formatWarmupFailureReason(result)}`,
            );
          }
        } catch (error: any) {
          this.logger.warn(
            `[warmup-demand] 预热失败: region=${regionPath}, ` +
            `account=${candidate.account.email.substring(0, 6)}*** — ${error.message}`,
          );
        }
      },
    );
  }

  /**
   * @description 读取指定地区当前属于候选账号集合且 session 仍有效的账号身份.
   * @param regionPath 目标地区路径
   * @param accounts 候选账号列表
   * @returns ready 的账号身份列表
   */
  private async getReadyWarmedAccountKeys(regionPath: string, accounts: WarmupAccount[]): Promise<string[]> {
    const candidateIdentitySet = new Set(
      accounts.map((account) => (account.accountKey || account.email.toLowerCase()).toLowerCase()),
    );
    const warmedEmails = await this.cacheService.getWarmedAccounts(regionPath);
    const warmedSessionKeys = warmedEmails.map((email) => `${email.toLowerCase()}:${regionPath}`);
    const warmedSessionStates = await this.cacheService.batchHasSession(warmedSessionKeys);
    return warmedEmails.filter((accountIdentity, index) => {
      return warmedSessionStates[index] && candidateIdentitySet.has(accountIdentity.toLowerCase());
    });
  }

  /**
   * @description 构建按需地区迁移前需要清理的地区集合.
   * @param targetRegionPath 当前要补齐的地区路径
   * @param boundRegion 当前账号已绑定的旧地区
   * @returns 去重后的地区路径列表
   */
  private buildOnDemandCleanupRegionPaths(targetRegionPath: string, boundRegion: string | null): string[] {
    return Array.from(new Set([
      ...HIGH_FREQUENCY_REGION_PATHS,
      ...(boundRegion ? [boundRegion] : []),
      targetRegionPath,
    ]));
  }

  /**
   * @description 监听批量登录完成事件 — 按「一账号一地区」原则异步预热 session.
   *
   * @param payload 事件数据: { accounts, warmupRegions?, jobId?, groupId? }
   * @sideEffects 异步初始化查询 session 并更新登录预热任务进度
   */
  // 不使用 async listener 包装; batch login 的 emitAsync 必须等待预热完成后再结算 job。
  @OnEvent('batch-login.completed')
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

    const warmupTasks = await this.planLoginWarmupTasks(accounts, payload.warmupRegions);
    if (warmupTasks.length === 0) {
      this.logger.log(
        `[login-warmup] 无需新增预热: accounts=${accounts.length}, ` +
        `regions=${this.normalizeRequestedWarmupRegions(payload.warmupRegions).join(',') || '(default)'}`,
      );
      await this.finishWarmupJob(payload.jobId, 0, 0, 0);
      return;
    }

    this.logger.log(
      `[login-warmup] 开始预热: accounts=${accounts.length}, tasks=${warmupTasks.length}, ` +
      `regions=${Array.from(new Set(warmupTasks.map((task) => task.regionPath))).join(',')}`,
    );
    await this.markWarmupJobStarted(payload.jobId, warmupTasks.length);

    const { successCount, failedCount } = await this.executeLoginWarmupTasksWithDynamicCapacity(
      warmupTasks,
      payload.jobId,
      LOGIN_WARMUP_CONCURRENCY,
    );
    await this.finishWarmupJob(payload.jobId, warmupTasks.length, successCount, failedCount);
  }

  /**
   * @description 为一批成功登录账号规划查询 session 预热任务.
   *
   * 规划只决定 account → region 的分配, 不执行任何慢 I/O 初始化。
   *
   * @param accounts 成功登录的账号凭据列表
   * @param warmupRegions 可选指定预热地区路径列表
   * @returns 单账号单地区预热计划列表
   */
  async planLoginWarmupTasks(
    accounts: WarmupAccount[],
    warmupRegions?: string[],
  ): Promise<PlannedAccountWarmupTask[]> {
    if (accounts.length === 0) return [];

    const requestedWarmupRegions = this.normalizeRequestedWarmupRegions(warmupRegions);
    const warmupTargets = requestedWarmupRegions.length > 0
      ? this.buildEvenWarmupTargets(accounts.length, requestedWarmupRegions)
      : this.getWarmupTargets();
    const targetRegionPaths = Array.from(warmupTargets.keys());
    const readyRegionByAccount = await this.getReadyWarmupRegionByAccount(accounts, targetRegionPaths);
    const warmupRegionSlots = this.buildWarmupRegionSlots(warmupTargets, readyRegionByAccount);

    if (warmupRegionSlots.length === 0) {
      return [];
    }

    const warmupTasks: PlannedAccountWarmupTask[] = [];
    for (const primaryAccount of accounts) {
      const primaryAccountKey = primaryAccount.accountKey || primaryAccount.email.toLowerCase();
      if (readyRegionByAccount.has(primaryAccountKey.toLowerCase())) {
        continue;
      }

      const assignment = await this.findAssignableWarmupRegion(primaryAccountKey, warmupRegionSlots);
      if (!assignment) {
        this.logger.warn(
          `[login-warmup] 账号 ${primaryAccount.email.substring(0, 6)}*** 无可用地区 (全部已被其他预热占用)`,
        );
        continue;
      }

      const cleanupRegionPaths = Array.from(new Set([
        ...HIGH_FREQUENCY_REGION_PATHS,
        ...warmupTargets.keys(),
        assignment.regionPath,
      ]));

      warmupRegionSlots.splice(assignment.slotIndex, 1);
      warmupTasks.push({
        regionPath: assignment.regionPath,
        cacheKey: `${primaryAccountKey}:${assignment.regionPath}`,
        account: {
          email: primaryAccount.email,
          password: primaryAccount.password,
          accountKey: primaryAccountKey,
          groupId: primaryAccount.groupId ?? null,
        },
        cleanupRegionPaths,
      });
    }

    return warmupTasks;
  }

  /**
   * @description 执行单账号单地区预热计划.
   * @param task 单账号单地区预热计划
   * @returns true 表示预热成功或目标 session 已存在
   * @sideEffects 更新 Redis session、地区预热索引和账号地区绑定
   */
  async executePlannedWarmupTask(
    task: PlannedAccountWarmupTask,
    priority: AppleInitializationPriority = 'background',
  ): Promise<boolean> {
    const result = await this.executePlannedWarmupTaskWithResult(task, priority);
    return result.success;
  }

  /**
   * @description 执行单账号单地区预热计划并返回结构化结果.
   * @param task 单账号单地区预热计划
   * @returns 查询 session 初始化结果
   * @sideEffects 清理旧绑定, 写入 Redis 查询 session, 并更新账号池错误信息
   */
  private async executePlannedWarmupTaskWithResult(
    task: PlannedAccountWarmupTask,
    priority: AppleInitializationPriority = 'background',
  ): Promise<QuerySessionInitializationResult> {
    await this.cleanupAccountRegionBindings(task.account.accountKey, task.cleanupRegionPaths);
    return this.initializeAndRecordWarmupResult(
      task.cacheKey,
      task.regionPath,
      task.account,
      priority,
    );
  }

  /**
   * @description 初始化查询 session 并把失败原因写回账号池.
   * @param cacheKey 查询 session cacheKey
   * @param regionPath 目标地区路径
   * @param account 当前预热账号
   * @returns 查询 session 初始化结果
   * @sideEffects 成功时清空账号错误信息; 失败时写入账号池 errorMessage
   */
  private async initializeAndRecordWarmupResult(
    cacheKey: string,
    regionPath: string,
    account: PlannedAccountWarmupTask['account'] | WarmupAccount,
    priority: AppleInitializationPriority = 'background',
  ): Promise<QuerySessionInitializationResult> {
    const result = await this.initializationLimiter.run(
      `query-session:${cacheKey}`,
      priority,
      () => this.accountSessionInitializer.initializeQuerySessionDetailed(
        cacheKey,
        regionPath,
        [account],
      ),
    );
    const accountKey = account.accountKey || this.identityService.buildAccountIdentity(account.email, account.groupId);

    if (result.success) {
      await this.cacheService.updateAccountFields(accountKey, { errorMessage: '' });
      return result;
    }

    await this.cacheService.updateAccountFields(accountKey, {
      errorMessage: this.buildAccountWarmupErrorMessage(regionPath, result),
    });
    return result;
  }

  /**
   * @description 使用动态容量窗口执行登录后的查询 session 预热.
   *
   * 这里维持固定数量的 worker, 每个 worker 完成当前任务后会立刻领取下一条任务,
   * 使并发窗口持续保持在上限附近; 避免按固定批次等待全部完成后才启动下一批。
   *
   * @param warmupTasks 待执行的单账号单地区预热计划
   * @param jobId 可选登录预热任务 ID
   * @param concurrency 最大并发窗口
   * @returns 本轮预热成功和失败数量
   * @sideEffects 初始化查询 session, 清理旧绑定并实时递增 Redis job 进度
   */
  private async executeLoginWarmupTasksWithDynamicCapacity(
    warmupTasks: PlannedAccountWarmupTask[],
    jobId: string | undefined,
    concurrency: number,
  ): Promise<{ successCount: number; failedCount: number }> {
    const workerCount = Math.max(1, Math.min(concurrency, warmupTasks.length));
    let nextTaskIndex = 0;
    let successCount = 0;
    let failedCount = 0;

    const runWorker = async (): Promise<void> => {
      while (nextTaskIndex < warmupTasks.length) {
        const task = warmupTasks[nextTaskIndex++];
        const result = await this.executeSingleLoginWarmupTask(task, jobId);
        if (result.success) {
          successCount++;
        } else {
          failedCount++;
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return { successCount, failedCount };
  }

  /**
   * @description 执行并记录单条登录预热任务.
   * @param task 单账号单地区预热计划
   * @param jobId 可选登录预热任务 ID
   * @returns 查询 session 初始化结果
   * @sideEffects 写入查询 session 并更新登录预热 job 进度
   */
  private async executeSingleLoginWarmupTask(
    task: PlannedAccountWarmupTask,
    jobId: string | undefined,
  ): Promise<QuerySessionInitializationResult> {
    try {
      const result = await this.executePlannedWarmupTaskWithResult(task, 'realtime');
      const errorMessage = result.success ? undefined : this.buildAccountWarmupErrorMessage(task.regionPath, result);
      await this.safeIncrementWarmupJob(jobId, result.success, task, errorMessage);
      if (!result.success) {
        this.logger.warn(
          `[login-warmup] 预热未成功: region=${task.regionPath}, ` +
          `account=${task.account.email.substring(0, 6)}***, reason=${this.formatWarmupFailureReason(result)}`,
        );
      }
      return result;
    } catch (error: any) {
      const errorMessage = `GiftCard预热异常: region=${task.regionPath}, message=${error.message}`;
      await this.cacheService.updateAccountFields(task.account.accountKey, { errorMessage });
      await this.safeIncrementWarmupJob(jobId, false, task, errorMessage);
      this.logger.warn(
        `[login-warmup] 预热失败: region=${task.regionPath} — ${error.message}`,
      );
      return {
        success: false,
        stage: 'init',
        errorMessage: error.message,
      };
    }
  }

  /**
   * @description 安全递增登录预热任务进度.
   *
   * 进度写入失败不能反向污染预热结果计数; 因此这里单独捕获 Redis job
   * 更新异常, 只记录上下文日志, 不让任务被重复统计为失败。
   *
   * @param jobId 可选登录预热任务 ID
   * @param success 当前预热任务是否成功
   * @param task 当前预热计划, 用于日志定位
   * @param errorMessage 失败时写入 job summary 的错误信息
   * @sideEffects 增量更新 Redis job summary
   */
  private async safeIncrementWarmupJob(
    jobId: string | undefined,
    success: boolean,
    task: PlannedAccountWarmupTask,
    errorMessage?: string,
  ): Promise<void> {
    try {
      await this.incrementWarmupJob(jobId, success, errorMessage);
    } catch (error: any) {
      this.logger.warn(
        `[login-warmup] 进度更新失败: region=${task.regionPath}, ` +
        `account=${task.account.email.substring(0, 6)}*** — ${error.message}`,
      );
    }
  }

  /**
   * @description 构建账号池中展示的预热失败原因.
   * @param regionPath 目标地区路径
   * @param result 查询 session 初始化结果
   * @returns 可展示且便于检索的错误信息
   */
  private buildAccountWarmupErrorMessage(
    regionPath: string,
    result: QuerySessionInitializationResult,
  ): string {
    return `GiftCard预热失败: region=${regionPath}, ${this.formatWarmupFailureReason(result)}`;
  }

  /**
   * @description 格式化查询 session 初始化失败结果.
   * @param result 查询 session 初始化结果
   * @returns 包含阶段、返回码和消息的诊断字符串
   */
  private formatWarmupFailureReason(result: QuerySessionInitializationResult): string {
    const details = [
      `stage=${result.stage}`,
      result.code !== undefined ? `code=${result.code}` : '',
      result.pos !== undefined ? `pos=${result.pos}` : '',
      result.responseCode !== undefined && result.responseCode >= 0 ? `response=${result.responseCode}` : '',
      result.errorMessage ? `message=${result.errorMessage}` : '',
    ].filter(Boolean);
    return details.join(', ');
  }

  /**
   * @description 从 apple_account 读取用户组内可用于查询上下文预热的账号.
   * @param groupId 用户组 ID; null 表示历史/全局资源池
   * @returns 预热账号凭据列表, accountKey 与账号池身份规则保持一致
   */
  private async buildWarmupAccountsForGroup(groupId: number | null): Promise<WarmupAccount[]> {
    const dbGroupId = groupId ?? 0;
    const accounts = await this.appleAccountRepo.find({
      where: { groupId: dbGroupId },
      order: { updatedAt: 'DESC' },
    });
    const warmupAccounts: WarmupAccount[] = [];

    for (const account of accounts) {
      if (!account.email || !account.password) continue;

      const email = account.email.toLowerCase();
      const accountKey = this.identityService.buildAccountIdentity(email, groupId);
      await this.syncDbAccountToPool(account, accountKey, groupId);
      warmupAccounts.push({
        email,
        password: account.password,
        groupId,
        accountKey,
      });
    }

    return warmupAccounts;
  }

  /**
   * @description 将 DB 账号同步到 Redis 查询账号池, 供 RosettaX 借出账号使用.
   * @param account DB 账号
   * @param accountKey 用户组内账号身份 key
   * @param groupId 用户组 ID
   * @sideEffects 写入 Redis 账号池 Hash 和用户组账号集合
   */
  private async syncDbAccountToPool(
    account: AppleAccount,
    accountKey: string,
    groupId: number | null,
  ): Promise<void> {
    const existing = await this.cacheService.getAccount(accountKey);
    const entry: SerializedPoolEntry = {
      groupId,
      email: account.email.toLowerCase(),
      password: account.password,
      sessionId: existing?.sessionId,
      region: account.region || existing?.region || 'unknown',
      creditDisplay: account.creditDisplay || existing?.creditDisplay,
      name: account.name || existing?.name,
      usageCount: existing?.usageCount || 0,
      lastUsedAt: existing?.lastUsedAt || 0,
      status: 'active',
    };

    await this.cacheService.saveAccount(accountKey, entry);
  }

  /**
   * @description 读取用户组已保存的预热地区.
   * @param groupId 用户组 ID
   * @returns 标准化地区路径列表
   */
  private async getConfiguredWarmupRegions(groupId: number | null): Promise<string[]> {
    const record = await this.warmupRecordRepo.findOne({ where: { groupId: groupId ?? 0 } });
    return this.parseStoredWarmupRegions(record?.regions || '');
  }

  /**
   * @description 解析 group_warm_up_record.regions.
   * @param raw DB 中保存的地区 JSON 或逗号分隔字符串
   * @returns 标准化地区路径列表
   */
  private parseStoredWarmupRegions(raw: string): string[] {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return this.normalizeRequestedWarmupRegions(parsed);
      }
    } catch { }

    return this.normalizeRequestedWarmupRegions(trimmed.split(','));
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
    try {
      const result = await this.initializationLimiter.run(
        `cache-repair:${cacheKey}`,
        'realtime',
        () => this.accountSessionInitializer.initializeQuerySessionDetailed(cacheKey, regionPath, accounts),
      );
      if (result.success) {
        return;
      }
      this.logger.warn(
        `[cache-repair] 修复未成功: key=${cacheKey}, reason=${reason}, ` +
        `failure=${this.formatWarmupFailureReason(result)}`,
      );
    } catch (error: any) {
      this.logger.warn(`[cache-repair] 修复失败: key=${cacheKey}, reason=${reason} — ${error.message}`);
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
   * @description 按目标容量和已就绪账号构建预热槽位列表.
   * @param targets 地区目标容量
   * @param readyRegionByAccount 已有可用 session 的账号到地区映射
   * @returns 待分配的地区槽位列表
   */
  private buildWarmupRegionSlots(
    targets: Map<string, number>,
    readyRegionByAccount: Map<string, string>,
  ): string[] {
    const slots: string[] = [];
    const readyCounts = new Map<string, number>();
    for (const regionPath of readyRegionByAccount.values()) {
      readyCounts.set(regionPath, (readyCounts.get(regionPath) || 0) + 1);
    }

    for (const [regionPath, targetCount] of targets) {
      const existingCount = readyCounts.get(regionPath) || 0;
      const missingCount = Math.max(targetCount - existingCount, 0);

      for (let i = 0; i < missingCount; i++) {
        slots.push(regionPath);
      }
    }

    return slots;
  }

  /**
   * @description 读取账号当前真实可用的预热地区.
   *
   * 只有 session key 存在且账号反向索引指向同一目标地区时才算 ready。
   * 这样旧 session 或旧 warmed set 不会让新任务误判容量已经满足。
   *
   * @param accounts 当前可用于预热的账号
   * @param targetRegionPaths 本次预热允许的目标地区
   * @returns accountKey 到 ready 地区的映射
   */
  private async getReadyWarmupRegionByAccount(
    accounts: WarmupAccount[],
    targetRegionPaths: string[],
  ): Promise<Map<string, string>> {
    const readyRegionByAccount = new Map<string, string>();
    if (accounts.length === 0 || targetRegionPaths.length === 0) {
      return readyRegionByAccount;
    }

    const targetRegionSet = new Set(targetRegionPaths);
    const accountKeys = accounts.map((account) =>
      (account.accountKey || account.email.toLowerCase()).toLowerCase(),
    );
    const boundRegions = await this.cacheService.batchGetAccountRegions(accountKeys);
    const sessionCheckKeys = accountKeys.map((accountKey, index) => {
      const boundRegion = boundRegions[index];
      return boundRegion && targetRegionSet.has(boundRegion) ? `${accountKey}:${boundRegion}` : '';
    });
    const sessionStates = await this.cacheService.batchHasSession(sessionCheckKeys.filter(Boolean));

    let sessionStateIndex = 0;
    accountKeys.forEach((accountKey, index) => {
      const boundRegion = boundRegions[index];
      if (!boundRegion || !targetRegionSet.has(boundRegion)) {
        return;
      }

      const hasSession = sessionStates[sessionStateIndex++];
      if (hasSession) {
        readyRegionByAccount.set(accountKey, boundRegion);
      }
    });

    return readyRegionByAccount;
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
   * @description 标准化单个地区路径.
   * @param region 原始地区值, 如 "us" 或 "/us"
   * @returns 标准化地区路径; 非法时返回 null
   */
  private normalizeSingleRegionPath(region?: string): string | null {
    const rawRegion = String(region || '').trim().toLowerCase();
    if (!rawRegion) return null;

    const regionPath = rawRegion.startsWith('/') ? rawRegion : `/${rawRegion}`;
    return /^\/[a-z]{2}$/.test(regionPath) ? regionPath : null;
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
    const accountKey = primaryAccountKey.toLowerCase();
    const [boundRegion] = await this.cacheService.batchGetAccountRegions([accountKey]);

    for (let slotIndex = 0; slotIndex < warmupRegionSlots.length; slotIndex++) {
      const regionPath = warmupRegionSlots[slotIndex];
      const cacheKey = `${accountKey}:${regionPath}`;
      const [hasSession] = await this.cacheService.batchHasSession([cacheKey]);
      if (!hasSession || boundRegion !== regionPath) {
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
   * @description 标记预热任务已开始.
   * @param jobId 可选登录预热任务 ID
   * @param total 预热任务总数
   * @sideEffects 更新 Redis job summary
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
   * @description 递增单个预热任务结果.
   * @param jobId 可选登录预热任务 ID
   * @param success 当前账号预热是否成功
   * @sideEffects 增量更新 Redis job summary, 让 Web 端能看到实时预热进度
   */
  private async incrementWarmupJob(
    jobId: string | undefined,
    success: boolean,
    errorMessage?: string,
  ): Promise<void> {
    if (!jobId) return;

    await this.cacheService.incrementLoginWarmupJob(jobId, {
      warmupFinished: 1,
      warmupSuccess: success ? 1 : 0,
      warmupFailed: success ? 0 : 1,
    }, !success && errorMessage ? { errorMessage } : {});
  }

  /**
   * @description 一次性写入预热最终结果.
   * @param jobId 可选登录预热任务 ID
   * @param total 预热任务总数
   * @param success 成功数量
   * @param failed 失败数量
   * @sideEffects 更新 Redis job summary
   */
  private async finishWarmupJob(
    jobId: string | undefined,
    total: number,
    success: number,
    failed: number,
  ): Promise<void> {
    if (!jobId) return;

    await this.cacheService.updateLoginWarmupJob(jobId, {
      status: 'warming',
      phase: 'warming',
      warmupTotal: total,
      warmupFinished: total,
      warmupSuccess: success,
      warmupFailed: failed,
    });
  }

  /**
   * @description 带并发度限制的动态补位任务执行器.
   *
   * 任一任务完成后立即补入下一条任务, 始终尽量维持最大并发窗口。
   *
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
      const task = handler(item).finally(() => {
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
