import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { RedisService } from '../../database/redis.service';
import { CACHE_KEYS } from '../../constants/cache-keys.constants';
import {
  DistributedCacheService,
  DistributedLockService,
  SerializedPoolEntry,
} from '../distributed-cache';
import { LoginResultDto } from '../itunes-client/interfaces/managed-session.interface';
import { ItunesClientService } from '../itunes-client/itunes-client.service';
import { SessionManagerService } from '../itunes-client/session-manager.service';
import { UserAccountPoolIdentityService } from '../user-account-pool-core/user-account-pool-identity.service';
import { UserAccountPoolStateService } from '../user-account-pool-state/user-account-pool-state.service';
import {
  LoginWarmupAccountInput,
  LoginWarmupOperator,
  LoginWarmupRunOptions,
  PoolEntry,
  RELOGIN_EXPIRED_BATCH_LIMIT,
  RELOGIN_LOCK_TTL_MS,
  UserLoginResult,
  WarmupAccountCredential,
} from '../user-account-pool-core/user-account-pool.types';

/**
 * @description GiftCardExchanger 兑换账号登录结果.
 *
 * 该结果只用于兑换账号调度, 不会把账号加入用户查询账号池。
 */
export interface ExchangeAccountLoginResult {
  /** Apple ID 邮箱 */
  email: string;
  /** 登录状态 */
  status: 'success' | 'needs_2fa' | 'failed';
  /** 成功或待 2FA 时的 Apple session ID */
  sessionId?: string;
  /** 账号所属地区代码 */
  region?: string;
  /** Apple Store-Front 原始值 */
  storeFront?: string;
  /** 格式化余额 */
  balance?: string | null;
  /** 原始余额字段 */
  creditBalance?: string | null;
  /** Apple 账号展示名 */
  name?: string;
  /** 登录失败原因 */
  errorMessage?: string;
  /** 余额刷新失败原因 */
  balanceError?: string;
}

/**
 * @description 用户账号池登录编排服务.
 *
 * 负责批量登录、手动 2FA、登录预热任务和后台 relogin。账号池 Redis
 * 状态写入委托给 UserAccountPoolStateService。
 */
@Injectable()
export class UserAccountPoolLoginService {
  private readonly logger = new Logger(UserAccountPoolLoginService.name);

  constructor(
    private readonly sessionManager: SessionManagerService,
    private readonly itunesClient: ItunesClientService,
    private readonly redisService: RedisService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cacheService: DistributedCacheService,
    private readonly lockService: DistributedLockService,
    private readonly identityService: UserAccountPoolIdentityService,
    private readonly stateService: UserAccountPoolStateService,
  ) { }

  /**
   * @description 创建异步批量登录 + 预热任务, 立即返回 jobId.
   * @param accounts 待登录账号列表
   * @param warmupRegions 可选预热地区路径列表
   * @param operator 操作者上下文
   * @returns 任务创建结果
   */
  async startLoginWarmupJob(
    accounts: LoginWarmupAccountInput[],
    warmupRegions?: string[],
    operator?: LoginWarmupOperator,
  ): Promise<{ jobId: string; status: string; phase: string }> {
    const groupId = operator?.groupId;
    if (groupId == null) {
      throw new Error('groupId 不能为空');
    }

    const jobId = `login-warmup-${Date.now()}-${randomUUID()}`;
    const now = Date.now();

    await this.cacheService.createLoginWarmupJob({
      jobId,
      status: 'queued',
      phase: 'queued',
      groupId,
      adminId: operator?.adminId,
      source: operator?.source,
      createdAt: now,
      updatedAt: now,
      loginTotal: accounts.length,
      loginFinished: 0,
      loginSuccess: 0,
      loginFailed: 0,
      loginNeeds2fa: 0,
      warmupTotal: 0,
      warmupFinished: 0,
      warmupSuccess: 0,
      warmupFailed: 0,
    });

    setImmediate(() => {
      this.runLoginWarmupJob(jobId, accounts, groupId, warmupRegions).catch((error: any) => {
        this.logger.error(`[UserPoolJob] 任务异常: jobId=${jobId}, error=${error.message}`, error.stack);
        this.cacheService.updateLoginWarmupJob(jobId, {
          status: 'failed',
          phase: 'done',
          errorMessage: error.message,
        }).catch(() => { });
      });
    });

    return { jobId, status: 'queued', phase: 'queued' };
  }

  /**
   * @description 批量登录用户提交的 Apple ID 账号.
   * @param accounts 账号列表
   * @param groupId 用户组 ID; null 表示历史/全局资源池
   * @param warmupRegions 可选预热地区路径列表
   * @param options 登录任务选项
   * @returns 每个账号的登录结果
   */
  async batchLogin(
    accounts: LoginWarmupAccountInput[],
    groupId: number | null,
    warmupRegions?: string[],
    options: LoginWarmupRunOptions = {},
  ): Promise<UserLoginResult[]> {
    const results: UserLoginResult[] = [];

    for (const account of accounts) {
      const result = await this.loginSingleAccount(account.email, account.password, groupId, account.twoFAUrl);
      results.push(result);
      if (options.jobId) {
        await this.recordLoginJobResult(options.jobId, result);
      }
    }

    await this.emitBatchLoginCompleted(results, groupId, warmupRegions, options);
    return results;
  }

  /**
   * @description 批量登录 GiftCardExchanger 兑换账号.
   *
   * 该流程只建立 Apple 兑换 session 并读取账号地区/余额, 不写入用户查询账号池,
   * 避免兑换账号被余额查询账号池误用。
   *
   * @param accounts 兑换账号列表
   * @param groupId 当前用户组 ID
   * @param options 任务选项; jobId 存在时逐账号写回 Redis job summary
   * @returns 兑换账号登录结果列表
   */
  async batchLoginExchangeAccounts(
    accounts: LoginWarmupAccountInput[],
    groupId: number | null,
    options: { jobId?: string } = {},
  ): Promise<ExchangeAccountLoginResult[]> {
    const results: ExchangeAccountLoginResult[] = [];

    for (const account of accounts) {
      const result = await this.loginSingleExchangeAccount(account.email, account.password, groupId);
      results.push(result);

      if (options.jobId) {
        await this.recordExchangeLoginJobResult(options.jobId, results, result);
      }
    }

    return results;
  }

  /**
   * @description 手动提交 2FA 验证码.
   * @param email 账号邮箱
   * @param code 6 位验证码
   * @param groupId 用户组 ID
   * @returns 登录结果
   */
  async submit2FAManual(email: string, code: string, groupId: number | null = null): Promise<UserLoginResult> {
    const emailKey = email.toLowerCase();
    const accountKey = this.identityService.buildAccountIdentity(emailKey, groupId);
    const entry = await this.cacheService.getAccount(accountKey);

    if (!entry || !entry.sessionId) {
      return { email, status: 'failed', errorMessage: '未找到待验证的会话' };
    }

    try {
      const result = await this.sessionManager.submit2FA(
        entry.sessionId,
        emailKey,
        entry.password,
        code,
        groupId,
      );

      if (result.status === 'success' && result.sessionId) {
        return await this.handleLoginSuccess(accountKey, emailKey, entry.password, entry.twoFAUrl, result, groupId);
      }

      await this.cacheService.updateAccountFields(accountKey, {
        status: 'login_failed',
        errorMessage: result.errorMessage || '2FA 验证失败',
      });

      return {
        email: emailKey,
        status: 'failed',
        errorMessage: result.errorMessage,
      };
    } catch (error: any) {
      await this.cacheService.updateAccountFields(accountKey, {
        status: 'login_failed',
        errorMessage: error.message,
      });

      return {
        email: emailKey,
        status: 'failed',
        errorMessage: error.message,
      };
    }
  }

  /**
   * @description 标记账号 session 过期, 并异步触发后台 relogin.
   * @param email 失效账号邮箱
   * @param groupId 用户组 ID
   * @param reason 调度原因
   * @sideEffects 清理旧 session/cache, 后台重新登录并触发预热事件
   */
  async expireAndScheduleRelogin(
    email: string,
    groupId: number | null = null,
    reason: string = 'session expired',
  ): Promise<void> {
    const emailKey = email.toLowerCase();
    const accountKey = this.identityService.buildAccountIdentity(emailKey, groupId);
    const entry = await this.cacheService.getAccount(accountKey);
    if (!entry || !entry.password) {
      this.logger.warn(`[UserPool] 无法调度 relogin, 账号不存在或缺少密码: ${emailKey}`);
      return;
    }

    await this.stateService.markExpired(emailKey, groupId);
    this.scheduleRelogin(entry, groupId, reason);
  }

  /**
   * @description 扫描过期或 Redis managed session 丢失的账号, 并后台 relogin.
   * @param limit 本轮最多调度的账号数量
   * @returns 扫描和调度数量
   */
  async reloginExpiredAccounts(
    limit: number = RELOGIN_EXPIRED_BATCH_LIMIT,
  ): Promise<{ scanned: number; scheduled: number }> {
    const accounts = await this.cacheService.getAllAccounts();
    let scanned = 0;
    let scheduled = 0;

    for (const account of accounts) {
      if (scheduled >= limit) break;
      scanned++;

      const groupId = account.groupId ?? null;
      if (account.status === 'expired') {
        this.scheduleRelogin(account, groupId, 'poll expired account');
        scheduled++;
        continue;
      }

      if (account.status !== 'active' || !account.sessionId) {
        continue;
      }

      const session = await this.sessionManager.getSession(account.sessionId);
      if (!session || session.status !== 'logged_in') {
        await this.expireAndScheduleRelogin(account.email, groupId, 'managed session missing');
        scheduled++;
      }
    }

    if (scheduled > 0) {
      this.logger.log(`[UserPool] relogin 扫描完成: scanned=${scanned}, scheduled=${scheduled}`);
    }

    return { scanned, scheduled };
  }

  /**
   * @description 为活跃用户组刷新即将过期的 managed login session.
   *
   * 该方法只针对账号池中仍为 active 的账号: Redis managed session 丢失时会走
   * expireAndScheduleRelogin; TTL 低于阈值时会后台强制 relogin, 但不会先摘除
   * 当前 session, 避免影响正在进行的业务请求。
   *
   * @param groupId 用户组 ID; null 表示历史/全局资源池
   * @param renewBeforeSeconds managed session 剩余 TTL 低于该秒数时触发后台刷新
   * @param limit 本轮最多调度的账号数量
   * @returns 扫描、调度和原因计数
   * @sideEffects 可能调度后台 Apple 登录并更新账号池 sessionId
   */
  async refreshExpiringManagedSessionsForGroup(
    groupId: number | null,
    renewBeforeSeconds: number,
    limit: number = RELOGIN_EXPIRED_BATCH_LIMIT,
  ): Promise<{ scanned: number; scheduled: number; missing: number; expiring: number }> {
    const accounts = await this.cacheService.getAllAccounts(groupId);
    let scanned = 0;
    let scheduled = 0;
    let missing = 0;
    let expiring = 0;

    for (const account of accounts) {
      if (scheduled >= limit) break;
      scanned++;

      const effectiveGroupId = account.groupId ?? groupId;
      if (account.status === 'expired') {
        this.scheduleRelogin(account, effectiveGroupId, 'active refresh expired account');
        scheduled++;
        missing++;
        continue;
      }

      if (account.status !== 'active' || !account.sessionId) {
        continue;
      }

      const redisKey = CACHE_KEYS.MANAGED_SESSION.build(account.sessionId);
      const ttlSeconds = await this.redisService.getClient().ttl(redisKey);
      if (ttlSeconds === -2) {
        await this.expireAndScheduleRelogin(account.email, effectiveGroupId, 'active refresh managed session missing');
        scheduled++;
        missing++;
        continue;
      }

      if (ttlSeconds >= 0 && ttlSeconds <= renewBeforeSeconds) {
        this.scheduleRelogin(
          account,
          effectiveGroupId,
          `active refresh managed session ttl=${ttlSeconds}s`,
          { force: true },
        );
        scheduled++;
        expiring++;
      }
    }

    if (scheduled > 0) {
      this.logger.log(
        `[UserPool] active managed session 刷新扫描完成: ` +
        `groupId=${groupId ?? 'global'}, scanned=${scanned}, scheduled=${scheduled}, ` +
        `missing=${missing}, expiring=${expiring}`,
      );
    }

    return { scanned, scheduled, missing, expiring };
  }

  /**
   * @description 后台执行批量登录 + 预热任务.
   * @param jobId 任务 ID
   * @param accounts 待登录账号列表
   * @param groupId 用户组 ID
   * @param warmupRegions 可选预热地区路径列表
   */
  private async runLoginWarmupJob(
    jobId: string,
    accounts: LoginWarmupAccountInput[],
    groupId: number,
    warmupRegions?: string[],
  ): Promise<void> {
    await this.cacheService.updateLoginWarmupJob(jobId, {
      status: 'logging_in',
      phase: 'logging_in',
    });

    await this.batchLogin(accounts, groupId, warmupRegions, {
      jobId,
      awaitWarmup: true,
    });

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

  /**
   * @description 将单账号登录结果累计到任务摘要.
   * @param jobId 任务 ID
   * @param result 单账号登录结果
   */
  private async recordLoginJobResult(jobId: string, result: UserLoginResult): Promise<void> {
    await this.cacheService.incrementLoginWarmupJob(jobId, {
      loginFinished: 1,
      loginSuccess: result.status === 'success' ? 1 : 0,
      loginFailed: result.status === 'failed' ? 1 : 0,
      loginNeeds2fa: result.status === 'needs_2fa' ? 1 : 0,
    });
  }

  /**
   * @description 异步发出批量登录完成事件 — 触发高频地区 session 预热.
   * @param results 批量登录结果列表
   * @param groupId 用户组 ID
   * @param warmupRegions 可选预热地区路径列表
   * @param options 登录任务选项
   */
  private async emitBatchLoginCompleted(
    results: UserLoginResult[],
    groupId: number | null = null,
    warmupRegions?: string[],
    options: LoginWarmupRunOptions = {},
  ): Promise<void> {
    const successEmails = results
      .filter((result) => result.status === 'success')
      .map((result) => result.email.toLowerCase());

    const enriched: WarmupAccountCredential[] = [];
    for (const email of successEmails) {
      const accountKey = this.identityService.buildAccountIdentity(email, groupId);
      const entry = await this.cacheService.getAccount(accountKey);
      if (entry) {
        enriched.push({ email: entry.email, password: entry.password, accountKey, groupId });
      }
    }

    if (enriched.length === 0) {
      this.logger.log('[UserPool] 无成功登录的账号, 跳过预热事件');
      return;
    }

    const payload = { accounts: enriched, warmupRegions, jobId: options.jobId, groupId };
    if (options.awaitWarmup) {
      await this.eventEmitter.emitAsync('batch-login.completed', payload);
      return;
    }

    setImmediate(() => {
      try {
        this.eventEmitter.emit('batch-login.completed', payload);
      } catch (error: any) {
        this.logger.error(`[UserPool] 发送预热事件异常: ${error.message}`);
      }
    });
  }

  /**
   * @description 登录单个 GiftCardExchanger 兑换账号.
   *
   * 兑换账号只保留 Apple managed session, 不加入查询账号池。这样客户端后续
   * 只能显式拿 sessionId 调用兑换接口, 不会污染余额查询账号选择。
   *
   * @param email Apple ID 邮箱
   * @param password Apple ID 密码
   * @param groupId 当前用户组 ID
   * @returns 兑换账号登录结果
   */
  private async loginSingleExchangeAccount(
    email: string,
    password: string,
    groupId: number | null,
  ): Promise<ExchangeAccountLoginResult> {
    const emailKey = email.toLowerCase();
    const startedAt = Date.now();

    try {
      this.logger.log(`[ExchangeLogin] 登录兑换账号: ${emailKey}`);
      const loginResult = await this.sessionManager.login(emailKey, password, { groupId });

      if (loginResult.status === 'success' && loginResult.sessionId) {
        const storeFront = loginResult.account?.storeFront || '';
        const region = this.identityService.parseRegionFromStoreFront(storeFront);
        let balance = loginResult.account?.creditDisplay || loginResult.account?.creditBalance || null;
        let balanceError: string | undefined;

        try {
          const refreshedBalance = await this.refreshExchangeAccountBalance(loginResult.sessionId);
          if (refreshedBalance) balance = refreshedBalance;
        } catch (error: any) {
          balanceError = error.message || '余额刷新失败';
          this.logger.warn(`[ExchangeLogin] 余额刷新失败: ${emailKey} — ${balanceError}`);
        }

        this.logger.log(
          `[ExchangeLogin] ✓ 登录完成: email=${emailKey}, region=${region || 'unknown'}, ` +
          `balance=${balance || 'N/A'}, elapsed=${Date.now() - startedAt}ms`,
        );

        return {
          email: emailKey,
          status: 'success',
          sessionId: loginResult.sessionId,
          region,
          storeFront,
          balance,
          creditBalance: loginResult.account?.creditBalance || null,
          name: loginResult.account?.name,
          balanceError,
        };
      }

      if (loginResult.status === 'needs_2fa' && loginResult.sessionId) {
        this.logger.warn(`[ExchangeLogin] 需要 2FA: email=${emailKey}, elapsed=${Date.now() - startedAt}ms`);
        return {
          email: emailKey,
          status: 'needs_2fa',
          sessionId: loginResult.sessionId,
          errorMessage: loginResult.errorMessage || '需要输入 2FA 验证码',
        };
      }

      this.logger.warn(
        `[ExchangeLogin] 登录失败: email=${emailKey}, error=${loginResult.errorMessage || '未知错误'}, ` +
        `elapsed=${Date.now() - startedAt}ms`,
      );
      return {
        email: emailKey,
        status: 'failed',
        errorMessage: loginResult.errorMessage || '登录失败',
      };
    } catch (error: any) {
      this.logger.error(`[ExchangeLogin] 登录异常: ${emailKey} — ${error.message}`, error.stack);
      return {
        email: emailKey,
        status: 'failed',
        errorMessage: error.message || '登录异常',
      };
    }
  }

  /**
   * @description 刷新兑换账号余额.
   *
   * 登录响应已有 creditDisplay 时直接复用; 否则用 iTunes 双链路余额接口补齐。
   * 该方法只服务兑换账号登录结果展示, 失败时不阻断账号登录成功。
   *
   * @param sessionId Apple managed session ID
   * @returns 格式化余额; 无法获取时返回 null
   */
  private async refreshExchangeAccountBalance(sessionId: string): Promise<string | null> {
    const session = await this.sessionManager.getLoggedInSession(sessionId);
    const account = session.account;
    if (!account) return null;

    if (account.creditDisplay) {
      return account.creditDisplay;
    }

    const proxy = await this.sessionManager.getSessionProxy(session);
    try {
      return await this.itunesClient.fetchBalance(
        account,
        session.sessionCookies,
        session.guid,
        proxy,
      );
    } catch (error: any) {
      const message = error.message || '';
      if (!message.includes('Connection refused') && !message.includes('Host unreachable')) {
        throw error;
      }

      this.logger.warn(`[ExchangeLogin] 余额刷新代理异常, 切换代理后重试: ${message}`);
      await this.sessionManager.reassignProxy(session);
      return this.itunesClient.fetchBalance(
        account,
        session.sessionCookies,
        session.guid,
        await this.sessionManager.getSessionProxy(session),
      );
    }
  }

  /**
   * @description 将单个兑换账号登录进度写回 Redis job summary.
   * @param jobId 任务 ID
   * @param results 当前已完成结果列表
   * @param latestResult 最新账号结果
   * @sideEffects 原子递增 job 计数并覆盖 resultJson
   */
  private async recordExchangeLoginJobResult(
    jobId: string,
    results: ExchangeAccountLoginResult[],
    latestResult: ExchangeAccountLoginResult,
  ): Promise<void> {
    await this.cacheService.incrementLoginWarmupJob(jobId, {
      loginFinished: 1,
      loginSuccess: latestResult.status === 'success' ? 1 : 0,
      loginFailed: latestResult.status === 'failed' ? 1 : 0,
      loginNeeds2fa: latestResult.status === 'needs_2fa' ? 1 : 0,
    }, {
      status: 'logging_in',
      phase: 'logging_in',
      resultJson: JSON.stringify(results),
      nextPollMs: 1000,
    });
  }

  /**
   * @description 登录单个账号.
   * @param email Apple ID 邮箱
   * @param password 密码
   * @param groupId 用户组 ID
   * @param twoFAUrl 可选 2FA 验证码获取 URL
   * @returns 登录结果
   */
  private async loginSingleAccount(
    email: string,
    password: string,
    groupId: number | null,
    twoFAUrl?: string,
  ): Promise<UserLoginResult> {
    const emailKey = email.toLowerCase();
    const accountKey = this.identityService.buildAccountIdentity(emailKey, groupId);

    try {
      this.logger.log(`[UserPool] 登录: ${email}`);
      const loginResult = await this.sessionManager.login(email, password, { groupId });

      if (loginResult.status === 'success' && loginResult.sessionId) {
        return await this.handleLoginSuccess(accountKey, emailKey, password, twoFAUrl, loginResult, groupId);
      }

      if (loginResult.status === 'needs_2fa' && loginResult.sessionId) {
        await this.stateService.addToPool(accountKey, {
          groupId,
          email: emailKey,
          password,
          twoFAUrl,
          sessionId: loginResult.sessionId,
          status: 'needs_2fa',
          region: '',
          usageCount: 0,
          lastUsedAt: 0,
        });

        return {
          email: emailKey,
          status: 'needs_2fa',
          sessionId: loginResult.sessionId,
        };
      }

      await this.stateService.addToPool(accountKey, {
        groupId,
        email,
        password,
        twoFAUrl,
        status: 'login_failed',
        region: '',
        usageCount: 0,
        lastUsedAt: 0,
        errorMessage: loginResult.errorMessage,
      });

      return {
        email,
        status: 'failed',
        errorMessage: loginResult.errorMessage,
      };
    } catch (error: any) {
      this.logger.error(`[UserPool] 登录异常: ${email} — ${error.message}`);
      await this.stateService.addToPool(accountKey, {
        groupId,
        email,
        password,
        twoFAUrl,
        status: 'login_failed',
        region: '',
        usageCount: 0,
        lastUsedAt: 0,
        errorMessage: error.message,
      });

      return {
        email,
        status: 'failed',
        errorMessage: error.message,
      };
    }
  }

  /**
   * @description 处理登录成功 — 解析地区, 加入池, 初始化 Redis 计数.
   * @param accountKey 用户组内账号身份 key
   * @param emailKey 小写邮箱
   * @param password 密码
   * @param twoFAUrl 可选 2FA URL
   * @param loginResult 登录结果
   * @param groupId 用户组 ID
   * @returns 登录成功结果
   */
  private async handleLoginSuccess(
    accountKey: string,
    emailKey: string,
    password: string,
    twoFAUrl: string | undefined,
    loginResult: LoginResultDto,
    groupId: number | null = null,
  ): Promise<UserLoginResult> {
    const region = this.identityService.parseRegionFromStoreFront(loginResult.account?.storeFront || '');
    const entry: PoolEntry = {
      groupId,
      email: emailKey,
      password,
      twoFAUrl,
      sessionId: loginResult.sessionId,
      region,
      creditDisplay: loginResult.account?.creditDisplay || undefined,
      name: loginResult.account?.name,
      usageCount: 0,
      lastUsedAt: 0,
      status: 'active',
    };

    await this.stateService.addToPool(accountKey, entry);
    this.stateService.initUsageCounter(accountKey).catch(() => { });

    this.logger.log(
      `[UserPool] ✓ 登录成功: ${emailKey}, region=${region}, balance=${entry.creditDisplay}`,
    );

    return {
      email: emailKey,
      status: 'success',
      sessionId: loginResult.sessionId,
      region,
      creditDisplay: entry.creditDisplay,
      name: entry.name,
    };
  }

  /**
   * @description 后台重新登录单个账号, 成功后触发查询 session 预热事件.
   * @param entry 账号池条目
   * @param groupId 用户组 ID
   * @param reason 调度原因
   * @param options relogin 调度选项; force=true 时用于临近 TTL 的无感刷新
   */
  private scheduleRelogin(
    entry: SerializedPoolEntry,
    groupId: number | null,
    reason: string,
    options: { force?: boolean } = {},
  ): void {
    setImmediate(() => {
      this.reloginAccountInBackground(entry.email, entry.password, entry.twoFAUrl, groupId, reason, options.force === true)
        .catch((error: any) => {
          this.logger.error(
            `[UserPool] 后台 relogin 异常: email=${entry.email}, reason=${reason}, error=${error.message}`,
            error.stack,
          );
        });
    });
  }

  /**
   * @description 后台重新登录单个账号, 成功后触发查询 session 预热事件.
   * @param email Apple ID 邮箱
   * @param password Apple ID 密码
   * @param twoFAUrl 可选 2FA 获取 URL
   * @param groupId 用户组 ID
   * @param reason 调度原因
   * @param forceRefresh true 时即使账号仍 active 也执行刷新式 relogin
   */
  private async reloginAccountInBackground(
    email: string,
    password: string,
    twoFAUrl: string | undefined,
    groupId: number | null,
    reason: string,
    forceRefresh: boolean = false,
  ): Promise<void> {
    const emailKey = email.toLowerCase();
    const accountKey = this.identityService.buildAccountIdentity(emailKey, groupId);
    const lock = await this.lockService.tryAcquire(`relogin:${accountKey}`, RELOGIN_LOCK_TTL_MS);

    if (!lock) {
      this.logger.debug(`[UserPool] relogin 已在执行, 跳过: ${emailKey}`);
      return;
    }

    try {
      const latest = await this.cacheService.getAccount(accountKey);
      if (!forceRefresh && latest?.status === 'active' && latest.sessionId) {
        this.logger.debug(`[UserPool] relogin 跳过, 账号已恢复: ${emailKey}`);
        return;
      }

      this.logger.log(`[UserPool] 后台 relogin 开始: ${emailKey}, reason=${reason}, force=${forceRefresh}`);
      const result = forceRefresh
        ? await this.refreshActiveAccountWithoutInvalidating(emailKey, password, twoFAUrl, groupId, reason)
        : await this.loginSingleAccount(emailKey, password, groupId, twoFAUrl);

      if (result.status === 'success') {
        await this.emitBatchLoginCompleted([result], groupId, undefined, { awaitWarmup: false });
        this.logger.log(`[UserPool] 后台 relogin 成功: ${emailKey}`);
        return;
      }

      this.logger.warn(
        `[UserPool] 后台 relogin 未成功: ${emailKey}, status=${result.status}, error=${result.errorMessage || 'none'}`,
      );
    } finally {
      await lock.release();
    }
  }

  /**
   * @description 无感刷新仍处于 active 状态的账号登录 session.
   *
   * 该流程用于 managed session 临近 Redis TTL 的提前刷新。与 loginSingleAccount 不同,
   * 失败时不会把账号池状态写成 login_failed, 因为旧 session 仍可能可用, 业务侧不应
   * 因预防性刷新失败而感知异常。
   *
   * @param emailKey 小写 Apple ID 邮箱
   * @param password Apple ID 密码
   * @param twoFAUrl 可选 2FA 获取 URL
   * @param groupId 用户组 ID
   * @param reason 调度原因
   * @returns 登录刷新结果; 只有 success 会更新账号池 sessionId
   * @sideEffects 成功时写入新的 managed session 和账号池状态
   */
  private async refreshActiveAccountWithoutInvalidating(
    emailKey: string,
    password: string,
    twoFAUrl: string | undefined,
    groupId: number | null,
    reason: string,
  ): Promise<UserLoginResult> {
    const accountKey = this.identityService.buildAccountIdentity(emailKey, groupId);
    const loginResult = await this.sessionManager.login(emailKey, password, { groupId });

    if (loginResult.status === 'success' && loginResult.sessionId) {
      this.logger.log(`[UserPool] active managed session 无感刷新成功: ${emailKey}, reason=${reason}`);
      return this.handleLoginSuccess(accountKey, emailKey, password, twoFAUrl, loginResult, groupId);
    }

    this.logger.warn(
      `[UserPool] active managed session 无感刷新未覆盖旧 session: ` +
      `email=${emailKey}, status=${loginResult.status}, reason=${reason}, ` +
      `error=${loginResult.errorMessage || 'none'}`,
    );

    return {
      email: emailKey,
      status: loginResult.status === 'needs_2fa' ? 'needs_2fa' : 'failed',
      sessionId: loginResult.sessionId,
      errorMessage: loginResult.errorMessage,
    };
  }

}
