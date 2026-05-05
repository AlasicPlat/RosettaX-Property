import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { RedisService } from '../../database/redis.service';
import { CACHE_KEYS } from '../../constants/cache-keys.constants';
import { DistributedCacheService } from '../distributed-cache';
import { UserAccountPoolIdentityService } from '../user-account-pool-core/user-account-pool-identity.service';
import { UserAccountPoolLoginService } from '../user-account-pool-login/user-account-pool-login.service';
import { AccountSessionWarmupService } from '../account-session-warmup/account-session-warmup.service';
import { MESSAGE_QUEUE_NAMES } from '../message-queue/message-queue.constants';
import { MessageQueueService } from '../message-queue/message-queue.service';
import { LoginQueueTask } from './user-account-login-task.types';

/**
 * @description 解析正整数环境变量.
 * @param key 环境变量名
 * @param fallback 默认值
 * @returns 解析后的正整数; 非法或缺失时返回默认值
 */
function parsePositiveIntEnv(key: string, fallback: number): number {
  const value = Number.parseInt(process.env[key] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Redis Stream consumer group name used by the RosettaX-Property account worker. */
const ACCOUNT_INITIALIZER_GROUP = process.env.ROSETTAX_PROPERTY_CONSUMER_GROUP || 'rosettax-property';
/** Number of tasks read from Redis Stream per polling round. */
const STREAM_READ_COUNT = parsePositiveIntEnv('ROSETTAX_PROPERTY_STREAM_READ_COUNT', 8);
/** 单 Property worker 的任务级并发数; 单任务内部仍由各领域服务控制账号并发. */
const STREAM_CONCURRENCY = parsePositiveIntEnv('ROSETTAX_PROPERTY_STREAM_CONCURRENCY', 4);
/** BullMQ 实时队列消费并发: 登录、2FA、relogin、单账号重建. */
const REALTIME_QUEUE_CONCURRENCY = parsePositiveIntEnv('ROSETTAX_PROPERTY_REALTIME_QUEUE_CONCURRENCY', 4);
/** BullMQ 后台队列消费并发: missing query account 等低优先级补容任务. */
const BACKGROUND_QUEUE_CONCURRENCY = parsePositiveIntEnv('ROSETTAX_PROPERTY_BACKGROUND_QUEUE_CONCURRENCY', 1);
/** Redis Stream blocking read timeout in milliseconds. */
const STREAM_BLOCK_MS = parsePositiveIntEnv('ROSETTAX_PROPERTY_STREAM_BLOCK_MS', 5_000);
/** group_warmup 后补 managed session 的单轮账号数, 避免一次性重登整组账号. */
const MANAGED_RECOVERY_BATCH_LIMIT = parsePositiveIntEnv('ROSETTAX_PROPERTY_MANAGED_RECOVERY_BATCH_LIMIT', 5);
/** 指定地区缺查询账号时, 每次追加的 ready session 数量. */
const MISSING_QUERY_ACCOUNT_REGION_INCREMENT = parsePositiveIntEnv('ROSETTAX_PROPERTY_MISSING_REGION_INCREMENT', 10);
/** 单账号上下文使用次数低于该值时视为刚重建过, 跳过重复重建消息. */
const SINGLE_ACCOUNT_REBUILD_USAGE_THRESHOLD = parsePositiveIntEnv('ROSETTAX_PROPERTY_REBUILD_USAGE_THRESHOLD', 5);
/** 后台地区补容执行锁 TTL, 防止同一 group+region 被多个 Pod 同时补容. */
const WARMUP_DEMAND_EXECUTION_LOCK_TTL_SECONDS = parsePositiveIntEnv(
  'ROSETTAX_PROPERTY_WARMUP_DEMAND_LOCK_TTL_SECONDS',
  10 * 60,
);
/** Redis compare-and-delete 脚本, 避免旧消息释放新消息持有的投递锁. */
const RELEASE_DEDUPE_LOCK_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

type RedisStreamEntry = [string, string[]];
type RedisStreamReadResponse = Array<[string, RedisStreamEntry[]]> | null;

/**
 * @description 用户账号登录任务消费者.
 *
 * 该服务只应在独立账号初始化应用中注册。它从消息队列消费 RosettaX 主服务
 * 投递的登录、2FA 和 relogin 任务, 并复用现有登录/预热领域服务写回共享 Redis。
 */
@Injectable()
export class UserAccountLoginTaskConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UserAccountLoginTaskConsumerService.name);
  private readonly consumerName = `${process.env.ROSETTAX_PROPERTY_CONSUMER_NAME || hostname()}-${process.pid}`;
  private running = false;

  /**
   * @description 注入任务消费依赖.
   * @param redisService Redis 客户端封装, 用于幂等锁和历史 Stream 兼容方法
   * @param messageQueueService 消息队列抽象服务, 当前底层为 BullMQ
   * @param cacheService 分布式缓存服务, 用于任务状态更新和账号读取
   * @param loginService 账号登录执行服务, 只在独立 worker 中使用
   * @param warmupService 查询 session 预热服务, 负责 DB 驱动的增量补齐
   * @param identityService 账号身份 key 生成器
   * @param eventEmitter 事件总线, 用于 2FA 成功后触发查询 session 预热
   */
  constructor(
    private readonly redisService: RedisService,
    private readonly messageQueueService: MessageQueueService,
    private readonly cacheService: DistributedCacheService,
    private readonly loginService: UserAccountPoolLoginService,
    private readonly warmupService: AccountSessionWarmupService,
    private readonly identityService: UserAccountPoolIdentityService,
    private readonly eventEmitter: EventEmitter2,
  ) { }

  /**
   * @description Nest 生命周期钩子, 启动消息队列消费者.
   *
   * 实时队列与后台队列使用独立并发窗口, 避免 `missing query account`
   * 补容任务占满实时修复链路。
   *
   * @sideEffects 注册 BullMQ Worker 并开始消费任务
   */
  onModuleInit(): void {
    this.running = true;
    this.messageQueueService.consume<LoginQueueTask>(
      MESSAGE_QUEUE_NAMES.USER_ACCOUNT_REALTIME,
      (task, context) => this.handleQueueTask(context.id, task),
      { concurrency: REALTIME_QUEUE_CONCURRENCY },
    );
    this.messageQueueService.consume<LoginQueueTask>(
      MESSAGE_QUEUE_NAMES.USER_ACCOUNT_BACKGROUND,
      (task, context) => this.handleQueueTask(context.id, task),
      { concurrency: BACKGROUND_QUEUE_CONCURRENCY },
    );
  }

  /**
   * @description Nest 生命周期钩子, 通知消费循环停止.
   */
  onModuleDestroy(): void {
    this.running = false;
  }

  /**
   * @description 处理 BullMQ 消息.
   * @param messageId 底层队列消息 ID
   * @param task 登录任务负载
   * @sideEffects 执行业务任务; 失败时更新 job 状态并抛出给底层队列记录失败
   */
  private async handleQueueTask(messageId: string, task: LoginQueueTask): Promise<void> {
    try {
      await this.handleTask(task);
    } catch (error: any) {
      this.logger.error(
        `[rosettax-property] 任务处理失败: messageId=${messageId}, ` +
        `type=${task?.type || 'unknown'}, error=${error.message}`,
        error.stack,
      );
      if (task && 'jobId' in task) {
        await this.cacheService.updateLoginWarmupJob(task.jobId, {
          status: 'failed',
          phase: 'done',
          errorMessage: error.message,
        }).catch(() => { });
      }
      throw error;
    }
  }

  /**
   * @description 主消费循环.
   *
   * 每轮取出 STREAM_READ_COUNT 条消息并以 STREAM_CONCURRENCY 并发度处理。
   * 每条消息处理完成后 XACK; 处理异常会更新任务状态为 failed 并 ACK, 防止毒消息无限阻塞队列。
   *
   * @sideEffects 持续读取并处理 Redis Stream 消息
   */
  private async consumeLoop(): Promise<void> {
    await this.ensureConsumerGroup();

    while (this.running) {
      try {
        const response = await this.readTasks();
        if (!response) continue;

        for (const [, entries] of response) {
          const executing = new Set<Promise<void>>();
          for (const [messageId, fields] of entries) {
            const p = this.handleStreamEntry(messageId, fields)
              .then(() => { executing.delete(p); });
            executing.add(p);
            if (executing.size >= STREAM_CONCURRENCY) {
              await Promise.race(executing);
            }
          }
          await Promise.all(executing);
        }
      } catch (error: any) {
        if (this.isConsumerGroupMissingError(error)) {
          this.logger.warn(
            `[rosettax-property] Redis Stream consumer group 丢失, 正在重建: ` +
            `stream=${CACHE_KEYS.USER_ACCOUNT_LOGIN_TASK_STREAM}, group=${ACCOUNT_INITIALIZER_GROUP}`,
          );
          await this.ensureConsumerGroup();
          continue;
        }

        this.logger.error(`[rosettax-property] 读取任务异常: ${error.message}`, error.stack);
        await this.sleep(1000);
      }
    }
  }

  /**
   * @description 确保 Redis Stream consumer group 存在.
   * @sideEffects 必要时创建 stream 和 consumer group
   */
  private async ensureConsumerGroup(): Promise<void> {
    try {
      await this.redisService.getClient().xgroup(
        'CREATE',
        CACHE_KEYS.USER_ACCOUNT_LOGIN_TASK_STREAM,
        ACCOUNT_INITIALIZER_GROUP,
        '0',
        'MKSTREAM',
      );
    } catch (error: any) {
      if (!String(error?.message || '').includes('BUSYGROUP')) {
        throw error;
      }
    }
  }

  /**
   * @description 从 Redis Stream 读取一批新任务.
   * @returns Redis Stream 读取结果; 超时无任务时返回 null
   */
  private async readTasks(): Promise<RedisStreamReadResponse> {
    return this.redisService.getClient().xreadgroup(
      'GROUP',
      ACCOUNT_INITIALIZER_GROUP,
      this.consumerName,
      'COUNT',
      STREAM_READ_COUNT,
      'BLOCK',
      STREAM_BLOCK_MS,
      'STREAMS',
      CACHE_KEYS.USER_ACCOUNT_LOGIN_TASK_STREAM,
      '>',
    ) as Promise<RedisStreamReadResponse>;
  }

  /**
   * @description 判断 Redis Stream consumer group 是否缺失.
   *
   * 部署或维护时如果 stream key 被删除, XREADGROUP 会返回 NOGROUP。
   * 该错误属于可恢复状态, worker 应重建 group 并继续消费, 不能让消费循环退出。
   *
   * @param error Redis 返回的错误对象
   * @returns true 表示 consumer group 或 stream 缺失
   */
  private isConsumerGroupMissingError(error: any): boolean {
    return String(error?.message || '').includes('NOGROUP');
  }

  /**
   * @description 等待指定毫秒数, 用于异常读取后的短暂退避.
   * @param milliseconds 等待时间
   * @returns 延迟完成的 Promise
   */
  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  /**
   * @description 处理单条 Redis Stream 消息.
   * @param messageId Redis Stream 消息 ID
   * @param fields Redis Stream 字段数组
   * @sideEffects 执行登录任务并 ACK 消息
   */
  private async handleStreamEntry(messageId: string, fields: string[]): Promise<void> {
    let task: LoginQueueTask | null = null;
    try {
      task = this.parseTask(fields);
      await this.handleTask(task);
    } catch (error: any) {
      this.logger.error(
        `[rosettax-property] 任务处理失败: messageId=${messageId}, ` +
        `type=${task?.type || 'unknown'}, error=${error.message}`,
        error.stack,
      );
      if (task && 'jobId' in task) {
        await this.cacheService.updateLoginWarmupJob(task.jobId, {
          status: 'failed',
          phase: 'done',
          errorMessage: error.message,
        }).catch(() => { });
      }
    } finally {
      await this.redisService.getClient().xack(
        CACHE_KEYS.USER_ACCOUNT_LOGIN_TASK_STREAM,
        ACCOUNT_INITIALIZER_GROUP,
        messageId,
      );
    }
  }

  /**
   * @description 解析 Redis Stream 字段为任务负载.
   * @param fields Redis Stream 字段数组
   * @returns 登录任务负载
   */
  private parseTask(fields: string[]): LoginQueueTask {
    const payloadIndex = fields.indexOf('payload');
    const payload = payloadIndex >= 0 ? fields[payloadIndex + 1] : '';
    if (!payload) {
      throw new Error('任务 payload 为空');
    }

    return JSON.parse(payload) as LoginQueueTask;
  }

  /**
   * @description 按任务类型分发处理逻辑.
   * @param task 登录任务负载
   */
  private async handleTask(task: LoginQueueTask): Promise<void> {
    switch (task.type) {
      case 'login_warmup':
        await this.handleLoginWarmup(task);
        return;
      case 'submit_2fa':
        await this.handleSubmitTwoFactor(task);
        return;
      case 'exchange_login':
        await this.handleExchangeLogin(task);
        return;
      case 'exchange_submit_2fa':
        await this.handleExchangeSubmitTwoFactor(task);
        return;
      case 'relogin':
        await this.handleRelogin(task);
        return;
      case 'group_warmup':
        await this.handleGroupWarmup(task);
        return;
      default:
        throw new Error(`未知登录任务类型: ${(task as any).type}`);
    }
  }

  /**
   * @description 处理批量登录和查询 session 预热任务.
   * @param task login_warmup 任务
   * @sideEffects 执行 Apple 登录、写入账号池状态、触发查询 session 预热并更新 job summary
   */
  private async handleLoginWarmup(task: Extract<LoginQueueTask, { type: 'login_warmup' }>): Promise<void> {
    await this.cacheService.updateLoginWarmupJob(task.jobId, {
      status: 'logging_in',
      phase: 'logging_in',
    });

    await this.loginService.batchLogin(task.accounts, task.groupId, task.warmupRegions, {
      jobId: task.jobId,
      awaitWarmup: true,
      limiterPriority: 'background',
    });
    await this.completeJobFromSummary(task.jobId);
  }

  /**
   * @description 处理手动 2FA 提交任务.
   * @param task submit_2fa 任务
   * @sideEffects 提交验证码, 登录成功时触发查询 session 预热并更新 job summary
   */
  private async handleSubmitTwoFactor(task: Extract<LoginQueueTask, { type: 'submit_2fa' }>): Promise<void> {
    await this.cacheService.updateLoginWarmupJob(task.jobId, {
      status: 'logging_in',
      phase: 'logging_in',
    });

    const result = await this.loginService.submit2FAManual(task.email, task.code, task.groupId);
    await this.cacheService.updateLoginWarmupJob(task.jobId, {
      status: result.status === 'success' ? 'warming' : 'partial_failed',
      phase: result.status === 'success' ? 'warming' : 'done',
      loginFinished: 1,
      loginSuccess: result.status === 'success' ? 1 : 0,
      loginFailed: result.status === 'failed' ? 1 : 0,
      loginNeeds2fa: result.status === 'needs_2fa' ? 1 : 0,
    });

    if (result.status === 'success') {
      await this.emitWarmupForAccount(task.email, task.groupId, task.jobId);
      await this.completeJobFromSummary(task.jobId);
    }
  }

  /**
   * @description 处理 GiftCardExchanger 兑换账号登录任务.
   *
   * 该任务不触发查询 session 预热, 只建立兑换用 managed session 并把结果写回 job summary。
   *
   * @param task exchange_login 任务
   * @sideEffects 执行 Apple 登录、刷新余额并更新 Redis job summary
   */
  private async handleExchangeLogin(task: Extract<LoginQueueTask, { type: 'exchange_login' }>): Promise<void> {
    this.logger.log(
      `[ExchangeLogin] 收到兑换账号登录任务: jobId=${task.jobId}, ` +
      `groupId=${task.groupId ?? 'global'}, total=${task.accounts.length}`,
    );
    await this.cacheService.updateLoginWarmupJob(task.jobId, {
      status: 'logging_in',
      phase: 'logging_in',
    });

    await this.loginService.batchLoginExchangeAccounts(task.accounts, task.groupId, {
      jobId: task.jobId,
    });
    await this.completeJobFromSummary(task.jobId);
  }

  /**
   * @description 处理 GiftCardExchanger 兑换账号手动 2FA 提交任务.
   *
   * 该任务不触发查询账号池预热, 只完成兑换账号 managed session 并把单账号
   * 结果写回 Redis job summary, 供客户端同步等待或轮询读取。
   *
   * @param task exchange_submit_2fa 任务
   * @sideEffects 提交 Apple 2FA、刷新余额并更新 Redis job summary
   */
  private async handleExchangeSubmitTwoFactor(task: Extract<LoginQueueTask, { type: 'exchange_submit_2fa' }>): Promise<void> {
    this.logger.log(
      `[ExchangeLogin] 收到兑换账号 2FA 任务: jobId=${task.jobId}, ` +
      `email=${task.email}, sessionId=${task.sessionId}`,
    );

    await this.cacheService.updateLoginWarmupJob(task.jobId, {
      status: 'logging_in',
      phase: 'logging_in',
    });

    const result = await this.loginService.submitExchangeAccount2FA(
      task.sessionId,
      task.email,
      task.password,
      task.code,
      task.groupId,
      task.twoFAUrl,
    );

    await this.cacheService.updateLoginWarmupJob(task.jobId, {
      status: result.status === 'success' ? 'completed' : 'partial_failed',
      phase: 'done',
      resultJson: JSON.stringify([result]),
      nextPollMs: 1000,
      loginFinished: 1,
      loginSuccess: result.status === 'success' ? 1 : 0,
      loginFailed: result.status === 'failed' ? 1 : 0,
      loginNeeds2fa: result.status === 'needs_2fa' ? 1 : 0,
    });
  }

  /**
   * @description 处理单账号 relogin 任务.
   * @param task relogin 任务
   * @sideEffects 执行 Apple relogin 并触发查询 session 修复/预热
   */
  private async handleRelogin(task: Extract<LoginQueueTask, { type: 'relogin' }>): Promise<void> {
    try {
      if (await this.shouldSkipReloginByDedupe(task)) {
        return;
      }
      if (await this.shouldSkipRelogin(task)) {
        return;
      }

      await this.loginService.batchLogin(
        [{ email: task.email, password: task.password, twoFAUrl: task.twoFAUrl }],
        task.groupId,
        undefined,
        { awaitWarmup: false, limiterPriority: 'realtime' },
      );
    } finally {
      await this.releaseReloginDedupe(task);
    }
  }

  /**
   * @description 处理用户组增量预热任务.
   * @param task group_warmup 任务
   * @sideEffects 从 DB 读取账号和预热地区, 只补齐缺失的查询 session
   */
  private async handleGroupWarmup(task: Extract<LoginQueueTask, { type: 'group_warmup' }>): Promise<void> {
    this.logger.log(
      `[group-warmup] 收到任务: groupId=${task.groupId ?? 'global'}, ` +
      `region=${task.requestedRegion || '(none)'}, ` +
      `account=${task.requestedAccount?.email ? this.maskEmail(task.requestedAccount.email) : '(none)'}, ` +
      `reason=${task.reason}`,
    );

    if (await this.shouldSkipGroupWarmupByDedupe(task)) {
      return;
    }

    if (task.requestedRegion && task.requestedAccount) {
      try {
        if (await this.shouldSkipRequestedAccountRebuild(task)) {
          return;
        }

        const rebuilt = await this.warmupService.rebuildRequestedAccountSession(
          task.groupId,
          task.requestedRegion,
          task.requestedAccount,
          task.reason,
        );
        this.logger.log(
          `[group-warmup] 单账号修复完成: groupId=${task.groupId ?? 'global'}, ` +
          `region=${task.requestedRegion}, account=${this.maskEmail(task.requestedAccount.email)}, ` +
          `success=${rebuilt}, reason=${task.reason}`,
        );
      } finally {
        await this.releaseGroupWarmupDedupe(task);
      }
      return;
    }

    if (task.requestedRegion && task.reason === 'missing query account') {
      const executionLock = await this.tryAcquireWarmupDemandExecutionLock(task);
      if (!executionLock.acquired) {
        this.logger.debug(
          `[group-warmup] 后台补容执行中, 当前消息已合并: groupId=${task.groupId ?? 'global'}, ` +
          `region=${task.requestedRegion}, reason=${task.reason}`,
        );
        await this.releaseGroupWarmupDedupe(task);
        return;
      }

      try {
        const result = await this.warmupService.ensureAdditionalRegionWarmupCapacity(
          task.groupId,
          task.requestedRegion,
          task.reason,
          MISSING_QUERY_ACCOUNT_REGION_INCREMENT,
        );
        const recovery = await this.loginService.reloginExpiredAccounts(MANAGED_RECOVERY_BATCH_LIMIT, task.groupId);
        this.logger.log(
          `[group-warmup] 热门地区补容完成: groupId=${result.groupId ?? 'global'}, ` +
          `region=${result.regionPath || task.requestedRegion}, readyBefore=${result.readyBefore ?? 'n/a'}, ` +
          `targetReady=${result.targetReady ?? 'n/a'}, accounts=${result.accountCount}, ` +
          `managedRecovery=${recovery.scheduled}/${recovery.scanned}, reason=${task.reason}`,
        );
      } finally {
        await this.releaseGroupWarmupDedupe(task);
        await this.releaseDedupeLock(executionLock.key, executionLock.token);
      }
      return;
    }

    try {
      const result = await this.warmupService.ensureGroupWarmupCapacity(
        task.groupId,
        task.reason,
        task.requestedRegion,
      );
      const recovery = await this.loginService.reloginExpiredAccounts(MANAGED_RECOVERY_BATCH_LIMIT, task.groupId);
      this.logger.log(
        `[group-warmup] 完成任务: groupId=${result.groupId ?? 'global'}, ` +
        `accounts=${result.accountCount}, regions=${result.regionCount}, ` +
        `managedRecovery=${recovery.scheduled}/${recovery.scanned}, reason=${task.reason}`,
      );
    } finally {
      await this.releaseGroupWarmupDedupe(task);
    }
  }

  /**
   * @description 判断 relogin 消息是否仍持有生产者投递锁.
   *
   * 新消息必须携带 dedupeToken 且 Redis 锁值一致才执行; 老消息没有 token 时,
   * 如果当前已有同账号投递锁, 说明有更新的消息在队列中或处理中, 当前消息跳过。
   *
   * @param task relogin 任务
   * @returns true 表示当前消息不应执行
   */
  private async shouldSkipReloginByDedupe(task: Extract<LoginQueueTask, { type: 'relogin' }>): Promise<boolean> {
    const dedupeKey = `rx:login-task:relogin:${task.accountKey}`;
    const currentToken = await this.redisService.getClient().get(dedupeKey);

    if (task.dedupeToken) {
      const shouldSkip = currentToken !== task.dedupeToken;
      if (shouldSkip) {
        this.logger.debug(`[relogin] 旧任务已跳过: account=${this.maskEmail(task.email)}, reason=${task.reason}`);
      }
      return shouldSkip;
    }

    if (currentToken) {
      this.logger.debug(`[relogin] 无 token 历史任务已合并: account=${this.maskEmail(task.email)}, reason=${task.reason}`);
      return true;
    }
    return false;
  }

  /**
   * @description 判断 relogin 消息是否已经被较新的登录结果覆盖.
   *
   * 队列里可能残留同一账号的旧恢复消息; 如果账号池已经是 active 且 managed
   * session 元数据仍存在, 说明已有其它消息完成恢复, 当前消息直接 ACK 即可。
   *
   * @param task relogin 任务
   * @returns true 表示应跳过实际登录
   */
  private async shouldSkipRelogin(task: Extract<LoginQueueTask, { type: 'relogin' }>): Promise<boolean> {
    const entry = await this.cacheService.getAccount(task.accountKey);
    if (!entry || entry.status !== 'active' || !entry.sessionId) {
      return false;
    }

    const sessionExists = await this.redisService.getClient().exists(CACHE_KEYS.MANAGED_SESSION.build(entry.sessionId));
    if (sessionExists !== 1) {
      return false;
    }

    this.logger.debug(
      `[relogin] 重复恢复任务已跳过: account=${this.maskEmail(entry.email)}, ` +
      `groupId=${task.groupId ?? 'global'}, reason=${task.reason}`,
    );
    return true;
  }

  /**
   * @description 判断 group_warmup 消息是否仍持有生产者投递锁.
   *
   * 该校验是消费者侧幂等兜底: 即使 Redis Stream 中残留重复消息, 只有当前
   * Redis 锁持有者才允许真正执行初始化/补容。
   *
   * @param task group_warmup 任务
   * @returns true 表示当前消息不应执行
   */
  private async shouldSkipGroupWarmupByDedupe(task: Extract<LoginQueueTask, { type: 'group_warmup' }>): Promise<boolean> {
    const dedupeKey = this.buildGroupWarmupDedupeKey(task);
    const currentToken = await this.redisService.getClient().get(dedupeKey);

    if (task.dedupeToken) {
      const shouldSkip = currentToken !== task.dedupeToken;
      if (shouldSkip) {
        this.logger.debug(
          `[group-warmup] 旧任务已跳过: groupId=${task.groupId ?? 'global'}, ` +
          `region=${task.requestedRegion || '(none)'}, reason=${task.reason}`,
        );
      }
      return shouldSkip;
    }

    if (currentToken) {
      this.logger.debug(
        `[group-warmup] 无 token 历史任务已合并: groupId=${task.groupId ?? 'global'}, ` +
        `region=${task.requestedRegion || '(none)'}, reason=${task.reason}`,
      );
      return true;
    }
    return false;
  }

  /**
   * @description 判断单账号查询上下文重建消息是否已过期.
   *
   * 上下文使用上限是 5 次; 如果 Property 收到消息时 Redis 中已经存在同一账号、
   * 同一地区的可用 session, 且使用次数仍低于阈值, 说明它是刚初始化出的新
   * 上下文, 当前消息多半是历史/并发重复消息, 应直接跳过。
   *
   * @param task group_warmup 单账号重建任务
   * @returns true 表示应跳过重建
   */
  private async shouldSkipRequestedAccountRebuild(
    task: Extract<LoginQueueTask, { type: 'group_warmup' }>,
  ): Promise<boolean> {
    const regionPath = this.normalizeRegionPath(task.requestedRegion);
    const requestedAccount = task.requestedAccount;
    if (!regionPath || !requestedAccount?.email) {
      return false;
    }

    const email = requestedAccount.email.toLowerCase();
    const effectiveGroupId = requestedAccount.groupId ?? task.groupId;
    const accountKey = (requestedAccount.accountKey || this.identityService.buildAccountIdentity(email, effectiveGroupId))
      .toLowerCase();
    const cacheKey = `${accountKey}:${regionPath}`;
    const hasValidSession = await this.cacheService.hasValidSession(cacheKey);
    if (!hasValidSession) {
      return false;
    }

    const usageStats = await this.cacheService.getUsageStats(cacheKey);
    const queryCount = usageStats?.queryCount ?? 0;
    if (queryCount >= SINGLE_ACCOUNT_REBUILD_USAGE_THRESHOLD) {
      return false;
    }

    this.logger.debug(
      `[group-warmup] 单账号重复重建已跳过: key=${cacheKey}, ` +
      `queryCount=${queryCount}, threshold=${SINGLE_ACCOUNT_REBUILD_USAGE_THRESHOLD}, reason=${task.reason}`,
    );
    return true;
  }

  /**
   * @description 释放 group_warmup 投递锁.
   * @param task group_warmup 任务
   * @sideEffects 仅当 Redis 锁值等于当前消息 token 时删除锁
   */
  private async releaseGroupWarmupDedupe(task: Extract<LoginQueueTask, { type: 'group_warmup' }>): Promise<void> {
    if (!task.dedupeToken) return;
    await this.releaseDedupeLock(this.buildGroupWarmupDedupeKey(task), task.dedupeToken);
  }

  /**
   * @description 释放 relogin 投递锁.
   * @param task relogin 任务
   * @sideEffects 仅当 Redis 锁值等于当前消息 token 时删除锁
   */
  private async releaseReloginDedupe(task: Extract<LoginQueueTask, { type: 'relogin' }>): Promise<void> {
    if (!task.dedupeToken) return;
    await this.releaseDedupeLock(`rx:login-task:relogin:${task.accountKey}`, task.dedupeToken);
  }

  /**
   * @description 获取后台地区补容执行锁.
   *
   * 生产者锁负责限制重复投递, 这里的执行锁负责多 Pod 场景下的消费者侧兜底。
   * 锁按用户组和地区拆分, 避免一个用户组的热门地区补容阻塞其它用户组。
   *
   * @param task missing query account 任务
   * @returns 锁信息; acquired=false 表示已有同组同地区补容正在执行
   * @sideEffects 写入 Redis 执行锁
   */
  private async tryAcquireWarmupDemandExecutionLock(
    task: Extract<LoginQueueTask, { type: 'group_warmup' }>,
  ): Promise<{ acquired: boolean; key: string; token: string }> {
    const key = this.buildWarmupDemandExecutionLockKey(task);
    const token = randomUUID();
    const result = await this.redisService.getClient().set(
      key,
      token,
      'EX',
      WARMUP_DEMAND_EXECUTION_LOCK_TTL_SECONDS,
      'NX',
    );
    return { acquired: result === 'OK', key, token };
  }

  /**
   * @description 构建后台地区补容执行锁 key.
   * @param task group_warmup 任务
   * @returns Redis 执行锁 key
   */
  private buildWarmupDemandExecutionLockKey(task: Extract<LoginQueueTask, { type: 'group_warmup' }>): string {
    const groupKey = task.groupId === null || task.groupId === undefined ? 'global' : `g${task.groupId}`;
    return `rx:worker:warmup-demand:${groupKey}:${this.normalizeRegionKey(task.requestedRegion)}`;
  }

  /**
   * @description 通过 token 比较释放 Redis 投递锁.
   * @param dedupeKey Redis 锁 key
   * @param dedupeToken 当前消息 token
   * @sideEffects 删除仍属于当前消息的 Redis 锁
   */
  private async releaseDedupeLock(dedupeKey: string, dedupeToken: string): Promise<void> {
    try {
      await this.redisService.getClient().eval(RELEASE_DEDUPE_LOCK_SCRIPT, 1, dedupeKey, dedupeToken);
    } catch (error: any) {
      this.logger.warn(`[login-queue] 投递锁释放失败: key=${dedupeKey}, err=${error.message}`);
    }
  }

  /**
   * @description 构建与 RosettaX 生产者一致的 group_warmup 投递锁 key.
   * @param task group_warmup 任务
   * @returns Redis 投递锁 key
   */
  private buildGroupWarmupDedupeKey(task: Extract<LoginQueueTask, { type: 'group_warmup' }>): string {
    const effectiveGroupId = task.requestedAccount?.groupId ?? task.groupId;
    const groupKey = effectiveGroupId === null || effectiveGroupId === undefined ? 'global' : `g${effectiveGroupId}`;
    const regionKey = this.normalizeRegionKey(task.requestedRegion);
    const accountKey = (task.requestedAccount?.accountKey || task.requestedAccount?.email || 'any').toLowerCase();
    const reasonKey = String(task.reason || 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    return `rx:dedupe:group-warmup:${groupKey}:${regionKey}:${accountKey}:${reasonKey}`;
  }

  /**
   * @description 标准化地区到 Redis key 使用的短标识.
   * @param region 原始地区路径
   * @returns 地区标识, 如 us
   */
  private normalizeRegionKey(region?: string): string {
    const normalized = String(region || 'none').trim().toLowerCase().replace(/^\/+/, '');
    return normalized || 'none';
  }

  /**
   * @description 标准化地区路径.
   * @param region 原始地区路径或代码
   * @returns 标准化路径, 如 /us; 非法时返回 null
   */
  private normalizeRegionPath(region?: string): string | null {
    const rawRegion = String(region || '').trim().toLowerCase();
    if (!rawRegion) return null;

    const regionPath = rawRegion.startsWith('/') ? rawRegion : `/${rawRegion}`;
    return /^\/[a-z]{2}$/.test(regionPath) ? regionPath : null;
  }

  /**
   * @description 脱敏账号邮箱, 用于任务日志.
   * @param email 原始邮箱
   * @returns 脱敏后的邮箱
   */
  private maskEmail(email: string): string {
    const [name, domain] = String(email || '').split('@');
    if (!name || !domain) return String(email || '');
    return `${name.slice(0, 3)}***@${domain}`;
  }

  /**
   * @description 2FA 成功后为单账号触发查询 session 预热事件.
   * @param email Apple ID 邮箱
   * @param groupId 用户组 ID
   * @sideEffects 发出 batch-login.completed 事件
   */
  private async emitWarmupForAccount(email: string, groupId: number | null, jobId?: string): Promise<void> {
    const accountKey = this.identityService.buildAccountIdentity(email, groupId);
    const entry = await this.cacheService.getAccount(accountKey);
    if (!entry || !entry.password) return;

    await this.eventEmitter.emitAsync('batch-login.completed', {
      accounts: [{ email: entry.email, password: entry.password, accountKey, groupId }],
      groupId,
      jobId,
    });
  }

  /**
   * @description 根据 job summary 计数写入最终状态.
   * @param jobId 登录预热任务 ID
   * @sideEffects 更新 Redis job summary
   */
  private async completeJobFromSummary(jobId: string): Promise<void> {
    const summary = await this.redisService.getClient()
      .hgetall(CACHE_KEYS.LOGIN_WARMUP_JOB_SUMMARY.build(jobId));
    const loginFailed = Number(summary.loginFailed || 0);
    const loginNeeds2fa = Number(summary.loginNeeds2fa || 0);
    const warmupFailed = Number(summary.warmupFailed || 0);

    await this.cacheService.updateLoginWarmupJob(jobId, {
      status: loginFailed > 0 || loginNeeds2fa > 0 || warmupFailed > 0 ? 'partial_failed' : 'completed',
      phase: 'done',
    });
  }
}
