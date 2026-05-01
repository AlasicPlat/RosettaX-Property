import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { hostname } from 'os';
import { RedisService } from '../../database/redis.service';
import { CACHE_KEYS } from '../../constants/cache-keys.constants';
import { DistributedCacheService } from '../distributed-cache';
import { UserAccountPoolIdentityService } from '../user-account-pool-core/user-account-pool-identity.service';
import { UserAccountPoolLoginService } from '../user-account-pool-login/user-account-pool-login.service';
import { LoginQueueTask } from './user-account-login-task.types';

/** Redis Stream consumer group name used by the RosettaX-Property account worker. */
const ACCOUNT_INITIALIZER_GROUP = 'rosettax-property';
/** Number of tasks read from Redis Stream per polling round. */
const STREAM_READ_COUNT = 5;
/** Redis Stream blocking read timeout in milliseconds. */
const STREAM_BLOCK_MS = 5_000;

type RedisStreamEntry = [string, string[]];
type RedisStreamReadResponse = Array<[string, RedisStreamEntry[]]> | null;

/**
 * @description 用户账号登录任务消费者.
 *
 * 该服务只应在独立账号初始化应用中注册。它从 Redis Stream 消费 RosettaX 主服务
 * 投递的登录、2FA 和 relogin 任务, 并复用现有登录/预热领域服务写回共享 Redis。
 */
@Injectable()
export class UserAccountLoginTaskConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UserAccountLoginTaskConsumerService.name);
  private readonly consumerName = `${hostname()}-${process.pid}`;
  private running = false;

  /**
   * @description 注入任务消费依赖.
   * @param redisService Redis 客户端封装, 用于 XREADGROUP/XACK
   * @param cacheService 分布式缓存服务, 用于任务状态更新和账号读取
   * @param loginService 账号登录执行服务, 只在独立 worker 中使用
   * @param identityService 账号身份 key 生成器
   * @param eventEmitter 事件总线, 用于 2FA 成功后触发查询 session 预热
   */
  constructor(
    private readonly redisService: RedisService,
    private readonly cacheService: DistributedCacheService,
    private readonly loginService: UserAccountPoolLoginService,
    private readonly identityService: UserAccountPoolIdentityService,
    private readonly eventEmitter: EventEmitter2,
  ) { }

  /**
   * @description Nest 生命周期钩子, 启动 Redis Stream 消费循环.
   * @sideEffects 创建 consumer group 并持续阻塞读取任务
   */
  onModuleInit(): void {
    this.running = true;
    this.consumeLoop().catch((error: any) => {
      this.logger.error(`[rosettax-property] 消费循环异常退出: ${error.message}`, error.stack);
    });
  }

  /**
   * @description Nest 生命周期钩子, 通知消费循环停止.
   */
  onModuleDestroy(): void {
    this.running = false;
  }

  /**
   * @description 主消费循环.
   *
   * 使用 Redis Stream consumer group 实现跨实例任务分发。每条消息处理完成后 XACK;
   * 处理异常会更新任务状态为 failed 并 ACK, 防止毒消息无限阻塞队列。
   *
   * @sideEffects 持续读取并处理 Redis Stream 消息
   */
  private async consumeLoop(): Promise<void> {
    await this.ensureConsumerGroup();
    this.logger.log(
      `[rosettax-property] 已启动: stream=${CACHE_KEYS.USER_ACCOUNT_LOGIN_TASK_STREAM}, ` +
      `group=${ACCOUNT_INITIALIZER_GROUP}, consumer=${this.consumerName}`,
    );

    while (this.running) {
      try {
        const response = await this.readTasks();
        if (!response) continue;

        for (const [, entries] of response) {
          for (const [messageId, fields] of entries) {
            await this.handleStreamEntry(messageId, fields);
          }
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
      case 'relogin':
        await this.handleRelogin(task);
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
    await this.cacheService.incrementLoginWarmupJob(task.jobId, {
      loginFinished: 1,
      loginSuccess: result.status === 'success' ? 1 : 0,
      loginFailed: result.status === 'failed' ? 1 : 0,
      loginNeeds2fa: result.status === 'needs_2fa' ? 1 : 0,
    });

    if (result.status === 'success') {
      await this.emitWarmupForAccount(task.email, task.groupId);
    }
    await this.completeJobFromSummary(task.jobId);
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
   * @description 处理单账号 relogin 任务.
   * @param task relogin 任务
   * @sideEffects 执行 Apple relogin 并触发查询 session 修复/预热
   */
  private async handleRelogin(task: Extract<LoginQueueTask, { type: 'relogin' }>): Promise<void> {
    await this.loginService.batchLogin(
      [{ email: task.email, password: task.password, twoFAUrl: task.twoFAUrl }],
      task.groupId,
      undefined,
      { awaitWarmup: false },
    );
  }

  /**
   * @description 2FA 成功后为单账号触发查询 session 预热事件.
   * @param email Apple ID 邮箱
   * @param groupId 用户组 ID
   * @sideEffects 发出 batch-login.completed 事件
   */
  private async emitWarmupForAccount(email: string, groupId: number | null): Promise<void> {
    const accountKey = this.identityService.buildAccountIdentity(email, groupId);
    const entry = await this.cacheService.getAccount(accountKey);
    if (!entry || !entry.password) return;

    this.eventEmitter.emit('batch-login.completed', {
      accounts: [{ email: entry.email, password: entry.password, accountKey, groupId }],
      groupId,
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
