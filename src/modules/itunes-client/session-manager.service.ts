import { Injectable, Logger, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { ItunesClientService, LoginRawResult } from './itunes-client.service';
import { AccountService } from '../account/account.service';
import { ProxyConfig, ProxyProvider, PROXY_PROVIDER } from '../proxy/proxy-config.interface';
import { RedisService } from '../../database/redis.service';
import { CACHE_KEYS } from '../../constants/cache-keys.constants';
import {
  ManagedSession,
  SessionAccountData,
  LoginResultDto,
  SessionInfoDto,
} from './interfaces/managed-session.interface';
import { AppleAccount } from '../../entities/apple-account.entity';

/**
 * @file session-manager.service.ts
 * @description 运行时会话管理器 — 1:1 对标 Java AccountManager.
 *
 * 核心职责:
 * 1. 管理 Apple ID 登录会话的完整生命周期 (login → 2FA → logged_in → logout)
 * 2. Redis 持久化 (TTL 24h) — 不使用内存 Map, 避免多 Pod 数据不一致
 * 3. 为每个会话分配独立的 Decodo sticky session 代理, 保证出口 IP 一致性
 * 4. 登录成功后将账号信息持久化到 MySQL (通过 AccountService)
 *
 * 20260414 重构说明:
 * - 代理获取从 ProxyPoolService (MySQL) 改为 IProyalProxyService (内存 + Redis)
 * - 代理绑定从 proxyId (DB 主键) 改为 proxySessionTag (代理 session 标识)
 * - 2FA 场景下复用同一 sessionTag, 修复原实现 IP 切换的 bug
 * - getSessionProxy() 使用 acquireForAccount() 保证 IP 一致性
 *
 * 20260423 重构说明:
 * - 代理服务商从 Decodo 切换到 iProyal (连接更稳定)
 *
 * Reference: @docs AccountManager.java (完整逻辑)
 */


/** 会话过期时间 (秒) — 24 小时 */
const SESSION_TTL_SECONDS = 24 * 3600;

/**
 * storeFront ID → region 代码映射.
 * Apple storeFront 格式: "143465-19,29" (中国大陆), "143441-1,29" (美国) 等.
 * 前缀数字是 storefront ID, 用于确定账号所属地区.
 */
const STOREFRONT_TO_REGION: Record<string, string> = {
  '143465': 'cn', '143441': 'us', '143462': 'jp', '143460': 'au',
  '143455': 'ca', '143443': 'de', '143442': 'fr', '143450': 'gb',
  '143449': 'it', '143454': 'es', '143466': 'kr', '143470': 'tw',
  '143463': 'hk', '143464': 'sg', '143467': 'in', '143469': 'br',
  '143468': 'mx', '143448': 'nl', '143456': 'se', '143457': 'no',
  '143458': 'dk', '143447': 'fi', '143459': 'ch', '143445': 'at',
  '143446': 'be', '143453': 'pt', '143461': 'nz', '143478': 'ru',
  '143451': 'pl', '143480': 'tr', '143479': 'za', '143475': 'th',
  '143473': 'my', '143474': 'ph', '143476': 'id', '143471': 'vn',
  '143481': 'ae', '143477': 'sa', '143491': 'il',
};

/**
 * @description Apple ID 登录选项.
 *
 * @property existingGuid 显式复用的设备指纹 GUID; 未传时优先复用 apple_account.guid
 * @property region 显式账号地区; 未传时优先从登录响应 storeFront 解析
 * @property groupId 当前用户组 ID; 用于 apple_account 入库归属
 */
export interface SessionLoginOptions {
  existingGuid?: string;
  region?: string;
  groupId?: number | null;
}

@Injectable()
export class SessionManagerService {
  private readonly logger = new Logger(SessionManagerService.name);

  constructor(
    private readonly itunesClient: ItunesClientService,
    private readonly accountService: AccountService,
    @Inject(PROXY_PROVIDER) private readonly proxyService: ProxyProvider,
    private readonly redisService: RedisService,
  ) { }

  // ==================== 登录流程 ====================

  /**
   * @description 登录 Apple ID (第一步) — 对标 Java AccountManager.login().
   *
   * 完整流程:
   * 1. 检查是否已有此邮箱的活跃会话 (防重复登录)
   * 2. 通过 DecodoProxyService 为账号分配 sticky session 代理
   * 3. 创建 ManagedSession + 生成 GUID
   * 4. 调用 ItunesClientService.login() 执行 MZFinance 认证
   * 5. 登录成功: 持久化到 MySQL + Redis
   * 6. 需要 2FA: 保持会话, 等待验证码
   * 7. 失败: 释放代理, 清理会话
   *
   * Reference: AccountManager.java L114-190
   *
   * @param email Apple ID 邮箱
   * @param password 密码
   * @param optionsOrExistingGuid 新版登录选项, 或兼容旧调用的 existingGuid 字符串
   * @param region 兼容旧调用的账号地区
   * @param groupId 兼容旧调用的用户组 ID
   * @returns LoginResultDto 登录结果
   */
  async login(
    email: string,
    password: string,
    optionsOrExistingGuid?: string | SessionLoginOptions,
    region?: string,
    groupId?: number | null,
  ): Promise<LoginResultDto> {
    // this.logger.log(`[SessionManager] 登录请求: ${email}`);
    const normalizedEmail = email.toLowerCase();
    const options = this.normalizeLoginOptions(optionsOrExistingGuid, region, groupId);
    const existingAccount = await this.findExistingAppleAccount(normalizedEmail);

    // 检查是否已有此邮箱的会话 (从 Redis 查询, 跨 Pod 一致) — 对标 Java L118-127
    const emailKey = CACHE_KEYS.EMAIL_TO_SESSION.build(normalizedEmail);
    const existingSessionId = await this.redisService.get(emailKey);
    if (existingSessionId) {
      const existing = await this.getSession(existingSessionId);
      if (existing && existing.status === 'logged_in') {
        this.logger.log(`[SessionManager] 账号已登录, sessionId=${existingSessionId}`);
        if (existing.account) {
          await this.persistAccount(
            existing.account,
            password,
            existing.guid || existingAccount?.guid || '',
            options.region || existing.region || undefined,
            options.groupId ?? existing.groupId ?? null,
            existingAccount,
          );
        } else if (existingAccount && existingAccount.password !== password) {
          await this.accountService.upsert({ email: normalizedEmail, password });
          this.logger.log(`[SessionManager] 已更新现有账号明文密码: ${normalizedEmail}`);
        }
        return {
          status: 'success',
          sessionId: existingSessionId,
          account: existing.account ? this.sanitizeAccount(existing.account) : undefined,
        };
      }
      // 清除旧会话, 释放旧代理 session
      await this.cleanupSession(existingSessionId);
    }

    // 随机代理
    const proxy = await this.proxyService.acquireRandom();
    // this.logger.log(
    //   `[SessionManager] 已分配代理: sessionTag=${proxy.sessionTag}, username=${proxy.username}`,
    // );

    // 创建新会话
    // 如果 apple_account 已存在, 复用其 GUID, 避免同一 Apple ID 频繁变更设备指纹触发风控.
    const sessionId = uuidv4();
    const guid = options.existingGuid || existingAccount?.guid || ItunesClientService.generateGuid();
    const session: ManagedSession = {
      sessionId,
      groupId: options.groupId ?? existingAccount?.groupId ?? null,
      email: normalizedEmail,
      password,
      status: 'awaiting_login',
      loginTime: Date.now(),
      proxySessionTag: proxy.sessionTag,
      guid,
      region: options.region || existingAccount?.region || '',
      account: null,
      sessionCookies: new Map(),
    };

    // email → sessionId 映射写入 Redis, 跨 Pod 防重复登录
    await this.redisService.set(
      CACHE_KEYS.EMAIL_TO_SESSION.build(normalizedEmail),
      sessionId,
      SESSION_TTL_SECONDS,
    );

    // 执行 MZFinance 登录 — 对标 Java L152-189
    const result = await this.itunesClient.login(normalizedEmail, password, guid, proxy);

    if (result.success && result.account) {
      // 登录成功
      session.account = result.account;
      session.status = 'logged_in';
      session.sessionCookies = result.sessionCookies;

      // this.logger.log(
      //   `[SessionManager] 登录成功: ${email} → sessionId=${sessionId}, creditDisplay=${result.account.creditDisplay}`,
      // );

      // 持久化到 MySQL — 对标 Java L165
      await this.persistAccount(result.account, password, guid, options.region, options.groupId, existingAccount);
      // 持久化到 Redis — 对标 Java L168
      await this.persistSession(sessionId, session);

      return {
        status: 'success',
        sessionId,
        account: this.sanitizeAccount(result.account),
      };
    }

    if (result.needs2FA) {
      // 需要 2FA — 保持 session 和代理绑定, 等待验证码
      session.status = 'awaiting_2fa';
      session.sessionCookies = result.sessionCookies;
      this.logger.log(`[SessionManager] 需要 2FA: ${normalizedEmail} → sessionId=${sessionId}`);

      await this.persistSession(sessionId, session);

      return {
        status: 'needs_2fa',
        sessionId,
        errorMessage: '需要输入 2FA 验证码',
      };
    }

    // 登录失败 — 释放代理 session
    this.logger.error(`[SessionManager] 登录失败: ${normalizedEmail} — ${result.errorMessage}`);
    await this.cleanupSession(sessionId);

    return {
      status: 'failed',
      errorMessage: result.errorMessage,
    };
  }

  /**
   * @description 提交 2FA 验证码 (第二步) — 对标 Java AccountManager.submit2FA().
   *
   * 复用同一 session 的代理 (同一出口 IP), 用密码+验证码重新登录.
   * 20260414 修复: 通过 acquireForAccount(email) 自动命中已有 sessionTag,
   * 保证 2FA 验证时出口 IP 与首次登录一致, 避免触发风控.
   *
   * Reference: AccountManager.java L201-234
   *
   * @param sessionId 会话 ID (login 返回的)
   * @param email Apple ID 邮箱
   * @param password 原始密码
   * @param code 6 位 2FA 验证码
   * @param groupId 当前用户组 ID; 用于 apple_account 入库归属
   * @returns LoginResultDto 验证结果
   */
  async submit2FA(
    sessionId: string,
    email: string,
    password: string,
    code: string,
    groupId?: number | null,
  ): Promise<LoginResultDto> {
    this.logger.log(`[SessionManager] 2FA 验证: sessionId=${sessionId}`);

    // 从 Redis 获取 session — 避免多 Pod 场景下内存数据缺失
    const session = await this.getSession(sessionId);
    if (!session) {
      return { status: 'failed', errorMessage: '会话不存在或已过期' };
    }
    if (session.status !== 'awaiting_2fa') {
      return { status: 'failed', errorMessage: `当前会话状态不是等待 2FA: ${session.status}` };
    }

    // 复用同一账号的 sticky session 代理 — acquireForAccount 自动命中内存缓存
    // 修复原实现中 getRandomActive() 每次返回不同代理导致 IP 切换的 bug
    const normalizedEmail = email.toLowerCase();
    const proxy = await this.proxyService.acquireForAccount(normalizedEmail);

    // 密码 + 验证码拼接 — 对标 Java L217
    session.password = password; // 保存原始密码 (不含验证码)
    const passwordWith2FA = password + code;

    const result = await this.itunesClient.login(normalizedEmail, passwordWith2FA, session.guid, proxy);

    if (result.success && result.account) {
      const effectiveGroupId = groupId ?? session.groupId ?? null;
      session.groupId = effectiveGroupId;
      session.account = result.account;
      session.status = 'logged_in';
      session.sessionCookies = result.sessionCookies;

      this.logger.log(`[SessionManager] 2FA 验证成功: ${normalizedEmail}, creditDisplay=${result.account.creditDisplay}`);

      await this.persistAccount(result.account, session.password, session.guid, session.region || undefined, effectiveGroupId);
      await this.persistSession(sessionId, session);

      return {
        status: 'success',
        sessionId,
        account: this.sanitizeAccount(result.account),
      };
    }

    this.logger.error(`[SessionManager] 2FA 验证失败: ${result.errorMessage}`);
    return { status: 'failed', errorMessage: result.errorMessage };
  }

  // ==================== 会话查询 ====================

  /**
   * @description 获取已验证的登录会话 — 对标 Java getLoggedInSession().
   *
   * 从 Redis session hash + cookies hash + MySQL 账号数据重建 ManagedSession
   *
   * 未登录或不存在则抛 HttpException.
   *
   * Reference: AccountManager.java L456-465
   */
  async getLoggedInSession(sessionId: string): Promise<ManagedSession> {
    let session = await this.reconstructSessionFromRedis(sessionId) ?? undefined;

    if (!session) {
      throw new HttpException(`会话不存在: ${sessionId}`, HttpStatus.NOT_FOUND);
    }
    if (session.status !== 'logged_in') {
      throw new HttpException(`账号未登录: ${session.status}`, HttpStatus.FORBIDDEN);
    }
    return session;
  }

  /**
   * @description 获取指定会话 (不做状态校验) — 从 Redis session hash + cookies hash + MySQL 账号数据重建 ManagedSession.
   */
  async getSession(sessionId: string) {
    return this.reconstructSessionFromRedis(sessionId);
  }

  /**
   * @description 获取所有已登录的账号 — 对标 Java getAllAccounts().
   *
   * 通过 Redis SCAN 遍历所有 `apple:session:*` key, 逐个重建 ManagedSession.
   * 不依赖内存 Map, 确保多 Pod 环境下数据一致性.
   *
   * Reference: AccountManager.java L240-246
   */
  async getAllSessions(): Promise<SessionInfoDto[]> {
    const list: SessionInfoDto[] = [];
    const redis = this.redisService.getClient();
    const prefix = CACHE_KEYS.MANAGED_SESSION.PREFIX;

    // SCAN 遍历所有 session key, 排除 cookies 子 key
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = nextCursor;

      for (const key of keys) {
        // 跳过 cookies hash key (格式: apple:session:{id}:cookies)
        if (key.endsWith(':cookies')) continue;

        // 从 key 中提取 sessionId
        const sessionId = key.slice(prefix.length);
        const session = await this.reconstructSessionFromRedis(sessionId);
        if (session) {
          list.push(this.toSessionInfoDto(session));
        }
      }
    } while (cursor !== '0');

    return list;
  }

  // ==================== 登出 + 清理 ====================

  /**
   * @description 登出指定账号 — 对标 Java AccountManager.logout().
   *
   * 释放 Decodo session + 清除 Redis session + 更新 MySQL 状态 + 移除内存索引.
   *
   * Reference: AccountManager.java L268-281
   */
  async logout(sessionId: string): Promise<boolean> {
    const session = await this.getSession(sessionId);
    if (!session) return false;

    // 更新 MySQL 状态 — 对标 Java L272
    if (session.account) {
      const dbAccount = await this.accountService.findByEmail(session.email);
      if (dbAccount) {
        await this.accountService.updateStatus(dbAccount.id, 'logged_out');
      }
    }

    await this.cleanupSession(sessionId);
    this.logger.log(`[SessionManager] 登出: ${session.email} → sessionId=${sessionId}`);
    return true;
  }

  /**
   * @description 清理会话资源 — 对标 Java AccountManager.cleanupSession().
   *
   * 移除内存索引 + 删除 Redis session + 释放 Decodo session 映射.
   *
   * Reference: AccountManager.java L512-525
   */
  async cleanupSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session) {
      // 释放代理 session 映射 — 下次登录会得到新的出口 IP
      await this.proxyService.releaseSession(session.email);

      // 删除 Redis 中的 session 数据 + email→sessionId 映射
      await this.redisService.del(
        CACHE_KEYS.MANAGED_SESSION.build(sessionId),
        CACHE_KEYS.MANAGED_SESSION_COOKIES.build(sessionId),
        CACHE_KEYS.EMAIL_TO_SESSION.build(session.email.toLowerCase()),
      );
    }
  }

  // ==================== 代理管理 ====================

  /**
   * @description 代理失效后轮换 session — 对标 Java AccountManager.reassignProxy().
   *
   * 通过 Decodo rotateSession 生成新 sessionTag, 自动获得新出口 IP.
   * 替代原实现的 getRandomActive() (从 MySQL 重选).
   *
   * Reference: AccountManager.java L428-448
   */
  async reassignProxy(session: ManagedSession): Promise<void> {
    const newProxy = await this.proxyService.rotateSession(session.email);
    session.proxySessionTag = newProxy.sessionTag;
    this.logger.log(
      `[SessionManager] ✓ 已轮换代理: email=${session.email}, newTag=${newProxy.sessionTag}`,
    );
  }

  /**
   * @description 获取会话绑定的代理配置 — 用于 RedeemService 等发起请求.
   *
   * 通过 acquireForAccount 自动命中内存缓存的 sessionTag, 保证 IP 一致性.
   */
  async getSessionProxy(session: ManagedSession): Promise<ProxyConfig> {
    return this.proxyService.acquireForAccount(session.email);
  }

  // ==================== 持久化辅助方法 ====================

  /**
   * @description 将账号信息写入 MySQL — 对标 Java persistAccount().
   *
   * 使用 AccountService.upsert() 实现幂等写入 (以 email 为唯一键).
   *
   * Reference: AccountManager.java L475-481
   *
   * @param account 账号运行时数据
   * @param password 账号密码 — MySQL password 列 NOT NULL, 必须写入
   * @param guid 设备指纹
   * @param region 可选 — 账号所属国家/地区 (来自 query_account_pool)
   * @param groupId 当前用户组 ID; null/undefined 时保留历史记录或写入全局组 0
   * @param knownExistingAccount 可选的已查询账号记录, 避免重复读取数据库
   */
  private async persistAccount(
    account: SessionAccountData,
    password: string,
    guid: string,
    region?: string,
    groupId?: number | null,
    knownExistingAccount?: AppleAccount | null,
  ): Promise<void> {
    try {
      const normalizedEmail = account.email.toLowerCase();
      const existingAccount = knownExistingAccount ?? await this.findExistingAppleAccount(normalizedEmail);
      const persistedGuid = guid || existingAccount?.guid || ItunesClientService.generateGuid();
      const persistedGroupId = groupId ?? existingAccount?.groupId ?? 0;
      // relogin 恢复依赖 apple_account.password, 这里必须保存用户提交的原始明文密码。
      const plainPassword = String(password || '');
      const passwordChanged = Boolean(existingAccount && existingAccount.password !== plainPassword);
      const data: Record<string, any> = {
        groupId: persistedGroupId,
        email: normalizedEmail,
        password: plainPassword,
        name: account.name || '',
        dsid: account.directoryServicesId || '',
        storeFront: account.storeFront || '',
        pod: account.pod || '',
        guid: persistedGuid,
        passwordToken: account.passwordToken,
        clearToken: account.clearToken,
        creditBalance: account.creditBalance || '',
        creditDisplay: account.creditDisplay || '',
        freeSongBalance: account.freeSongBalance || '',
        status: 'logged_in',
        lastLoginAt: new Date(),
      };
      // region 是 NOT NULL 列, 必须写入:
      // 优先使用显式传入的 region → 其次从 storeFront 解析 → 兜底 'unknown'
      data.region = region || existingAccount?.region || this.parseRegionFromStoreFront(account.storeFront || '') || 'unknown';

      // [DEBUG] 诊断 apple_account 写入问题 — 打印完整入库数据
      this.logger.log(
        `[SessionManager][DEBUG] persistAccount 准备写入: email=${normalizedEmail}, groupId=${persistedGroupId}, ` +
        `region=${data.region}, guid=${persistedGuid}, existingAccount=${existingAccount ? 'YES(id=' + existingAccount.id + ')' : 'NO'}, ` +
        `passwordToken=${account.passwordToken ? 'YES(' + account.passwordToken.length + 'chars)' : 'NULL'}, ` +
        `clearToken=${account.clearToken ? 'YES' : 'NULL'}, dsid=${data.dsid || 'EMPTY'}`,
      );

      await this.accountService.upsert(data);
      if (passwordChanged) {
        this.logger.log(`[SessionManager] 已更新现有账号明文密码: ${normalizedEmail}`);
      }

      // [DEBUG] 确认写入成功
      this.logger.log(`[SessionManager][DEBUG] persistAccount 写入成功: ${normalizedEmail}`);
    } catch (error: any) {
      // [DEBUG] 增强错误日志 — 打印完整堆栈和入库参数
      this.logger.error(
        `[SessionManager] 持久化账号失败: ${account.email} — ${error.message}\n` +
        `  入参: guid=${guid}, region=${region}, groupId=${groupId}\n` +
        `  account 字段: name=${account.name}, dsid=${account.directoryServicesId}, ` +
        `storeFront=${account.storeFront}, pod=${account.pod}, ` +
        `passwordToken=${account.passwordToken ? 'YES' : 'NULL'}, clearToken=${account.clearToken ? 'YES' : 'NULL'}`,
        error.stack,
      );
    }
  }

  /**
   * @description 将会话元数据写入 Redis — 对标 Java persistSession() + saveSessionCookies().
   *
   * Key 结构:
   *   apple:session:{sessionId}          → Hash (元数据)
   *   apple:session:{sessionId}:cookies  → Hash (session cookies)
   *
   * Reference: AccountManager.java L489-505
   * Reference: SessionStore.java L44-106
   */
  private async persistSession(sessionId: string, session: ManagedSession): Promise<void> {
    try {
      // 保存元数据
      const metaKey = CACHE_KEYS.MANAGED_SESSION.build(sessionId);
      const metadata: Record<string, string> = {
        email: session.email,
        status: session.status,
        loginTime: String(session.loginTime),
        proxySessionTag: session.proxySessionTag,
      };
      if (session.groupId !== undefined && session.groupId !== null) {
        metadata.groupId = String(session.groupId);
      }
      if (session.account) {
        metadata.dsid = session.account.directoryServicesId || '';
        metadata.guid = session.guid;
      }

      // 使用 Redis pipeline 写入元数据
      const redis = this.redisService.getClient();
      const pipeline = redis.pipeline();
      for (const [field, value] of Object.entries(metadata)) {
        pipeline.hset(metaKey, field, value);
      }
      pipeline.expire(metaKey, SESSION_TTL_SECONDS);

      // 保存 session cookies (独立 hash key)
      if (session.sessionCookies.size > 0) {
        const cookieKey = CACHE_KEYS.MANAGED_SESSION_COOKIES.build(sessionId);
        for (const [name, value] of session.sessionCookies) {
          pipeline.hset(cookieKey, name, value);
        }
        pipeline.expire(cookieKey, SESSION_TTL_SECONDS);
      }

      await pipeline.exec();
      // this.logger.log(
      //   `[SessionManager] ✓ 保存 session: ${sessionId} (TTL=${SESSION_TTL_SECONDS}s, fields=${Object.keys(metadata).length})`,
      // );
    } catch (error: any) {
      this.logger.error(`[SessionManager] 持久化 session 失败: ${sessionId} — ${error.message}`);
    }
  }

  /**
   * @description 从 Redis session hash + cookies hash + MySQL 重建 ManagedSession.
   *
   * 所有 session 查询均通过此方法, 确保多 Pod 数据一致性.
   * 不缓存到内存 Map — Redis 是唯一的 session 数据源.
   *
   * @param sessionId 会话 ID
   * @returns 重建的 ManagedSession, 不存在返回 null
   */
  private async reconstructSessionFromRedis(sessionId: string): Promise<ManagedSession | null> {
    try {
      const metaKey = CACHE_KEYS.MANAGED_SESSION.build(sessionId);
      const meta = await this.redisService.hgetall(metaKey);

      // Redis 中没有此 session 的元数据
      if (!meta || !meta.email) {
        return null;
      }

      // 从 Redis 读取 session cookies
      const cookieKey = CACHE_KEYS.MANAGED_SESSION_COOKIES.build(sessionId);
      const cookieData = await this.redisService.hgetall(cookieKey);
      const sessionCookies = new Map<string, string>();
      if (cookieData) {
        for (const [name, value] of Object.entries(cookieData)) {
          sessionCookies.set(name, value);
        }
      }

      // 从 MySQL 获取完整的账号数据 (包含 passwordToken / clearToken 等认证凭据)
      const dbAccount = await this.accountService.findByEmail(meta.email);
      let account: SessionAccountData | null = null;

      if (dbAccount) {
        account = {
          email: dbAccount.email,
          name: dbAccount.name || '',
          passwordToken: dbAccount.passwordToken || '',
          directoryServicesId: dbAccount.dsid || meta.dsid || '',
          storeFront: dbAccount.storeFront || '',
          pod: dbAccount.pod || '',
          clearToken: dbAccount.clearToken || null,
          creditBalance: dbAccount.creditBalance || null,
          creditDisplay: dbAccount.creditDisplay || null,
          freeSongBalance: dbAccount.freeSongBalance || null,
        };
      }

      // 重建 ManagedSession
      const session: ManagedSession = {
        sessionId,
        groupId: meta.groupId ? Number(meta.groupId) : dbAccount?.groupId ?? null,
        email: meta.email,
        password: dbAccount?.password || '',
        status: (meta.status as ManagedSession['status']) || 'expired',
        loginTime: parseInt(meta.loginTime || '0', 10),
        proxySessionTag: meta.proxySessionTag || '',
        guid: meta.guid || dbAccount?.guid || '',
        region: dbAccount?.region || '',
        account,
        sessionCookies,
      };



      // this.logger.log(
      //   `[SessionManager] ✓ 从 Redis 重建 session: ${sessionId}, email=${meta.email}, status=${session.status}`,
      // );

      return session;
    } catch (error: any) {
      this.logger.warn(
        `[SessionManager] 从 Redis 重建 session 失败: ${sessionId} — ${error.message}`,
      );
      return null;
    }
  }

  // ==================== 序列化辅助方法 ====================

  /**
   * @description 将 ManagedSession 序列化为 API 响应格式 — 对标 Java ManagedAccount.toMap().
   *
   * Reference: AccountManager.java L68-84
   */
  private toSessionInfoDto(session: ManagedSession): SessionInfoDto {
    const dto: SessionInfoDto = {
      sessionId: session.sessionId,
      email: session.email,
      status: session.status,
      loginTime: session.loginTime,
      proxySessionTag: session.proxySessionTag,
    };
    if (session.account) {
      dto.name = session.account.name;
      dto.dsid = session.account.directoryServicesId;
      dto.storeFront = session.account.storeFront;
      dto.creditBalance = session.account.creditBalance;
      dto.creditDisplay = session.account.creditDisplay;
      dto.freeSongBalance = session.account.freeSongBalance;
    }
    return dto;
  }

  /**
   * @description 账号数据脱敏 — 移除 passwordToken / clearToken, 用于 API 响应
   */
  private sanitizeAccount(account: SessionAccountData): Omit<SessionAccountData, 'passwordToken' | 'clearToken'> {
    const { passwordToken, clearToken, ...safe } = account;
    return safe;
  }

  /**
   * @description 兼容旧版参数并标准化登录选项.
   * @param optionsOrExistingGuid 新版 options 对象或旧版 existingGuid 字符串
   * @param region 旧版地区参数
   * @param groupId 旧版用户组参数
   * @returns 标准化后的登录选项
   */
  private normalizeLoginOptions(
    optionsOrExistingGuid?: string | SessionLoginOptions,
    region?: string,
    groupId?: number | null,
  ): SessionLoginOptions {
    if (typeof optionsOrExistingGuid === 'object' && optionsOrExistingGuid !== null) {
      return optionsOrExistingGuid;
    }

    return {
      existingGuid: optionsOrExistingGuid,
      region,
      groupId,
    };
  }

  /**
   * @description 根据邮箱读取 apple_account 历史记录.
   *
   * 登录前复用已有 GUID 是降低 Apple 风控概率的关键路径; 查询失败时仅记录告警,
   * 不阻断登录本身, 让账号仍可使用新 GUID 尝试登录.
   *
   * @param email 已标准化的小写 Apple ID 邮箱
   * @returns 已存在的账号记录, 不存在或查询失败返回 null
   */
  private async findExistingAppleAccount(email: string): Promise<AppleAccount | null> {
    try {
      return this.accountService.findByEmail(email);
    } catch (error: any) {
      this.logger.warn(`[SessionManager] 查询 apple_account 失败: ${email} — ${error.message}`);
      return null;
    }
  }

  /**
   * @description 按地区获取一个已登录的 session — 用于兑换礼品卡时匹配卡的地区.
   *
   * 通过 Redis SCAN 遍历所有 session key, 重建后按 region + status 筛选.
   * 返回第一个匹配的 session.
   *
   * @param region 目标地区代码 (如 'jp', 'cn')
   * @returns 匹配的 ManagedSession, 或 null
   */
  async getLoggedInSessionByRegion(region: string): Promise<ManagedSession | null> {
    const redis = this.redisService.getClient();
    const prefix = CACHE_KEYS.MANAGED_SESSION.PREFIX;

    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = nextCursor;

      for (const key of keys) {
        if (key.endsWith(':cookies')) continue;

        const sessionId = key.slice(prefix.length);
        const session = await this.reconstructSessionFromRedis(sessionId);
        if (session && session.status === 'logged_in' && session.region === region) {
          return session;
        }
      }
    } while (cursor !== '0');

    return null;
  }

  /**
   * @description 按地区获取所有已登录的 session 列表 — 用于批量兑换路由.
   *
   * 通过 Redis SCAN 遍历所有 session key, 重建后按 region + status 筛选.
   *
   * @param region 目标地区代码 (如 'jp', 'cn')
   * @returns 匹配的 ManagedSession 数组
   */
  async getLoggedInSessionsByRegion(region: string): Promise<ManagedSession[]> {
    const result: ManagedSession[] = [];
    const redis = this.redisService.getClient();
    const prefix = CACHE_KEYS.MANAGED_SESSION.PREFIX;

    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
      cursor = nextCursor;

      for (const key of keys) {
        if (key.endsWith(':cookies')) continue;

        const sessionId = key.slice(prefix.length);
        const session = await this.reconstructSessionFromRedis(sessionId);
        if (session && session.status === 'logged_in' && session.region === region) {
          result.push(session);
        }
      }
    } while (cursor !== '0');

    return result;
  }

  /**
   * @description 从 Apple storeFront 字符串解析地区代码.
   *
   * storeFront 格式: "143465-19,29" — 提取前缀数字查找映射.
   *
   * @param storeFront Apple Store-Front 值
   * @returns 地区代码 (如 'cn'), 无法识别时返回空字符串
   */
  private parseRegionFromStoreFront(storeFront: string): string {
    if (!storeFront) return '';
    const sfId = storeFront.split('-')[0]?.trim();
    return (sfId && STOREFRONT_TO_REGION[sfId]) || '';
  }
}
