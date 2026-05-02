import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../database/redis.service';
import { CACHE_KEYS } from '../../constants/cache-keys.constants';
import {
  SerializedSession,
  SerializedUsageStats,
  SerializedPoolEntry,
  SerializedActiveSessionCandidate,
  SerializedLoginWarmupJobSummary,
  SerializedGroupActivity,
} from './interfaces/serialized-session.interface';

/** 默认业务活跃心跳 TTL: 保留 2 小时, 由 Property 通过 score 控制实际空闲窗口. */
const GROUP_ACTIVITY_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * @file distributed-cache.service.ts
 * @description 分布式缓存服务 — 基于 Redis 的跨 Pod 共享缓存层.
 *
 * 职责:
 * 1. Session 缓存: 存储/读取/淘汰已初始化的礼品卡查询 session
 * 2. 使用统计: 原子计数器, 驱动账号轮换预热策略
 * 3. 账号池: 跨 Pod 共享用户登录的账号信息
 *
 * 所有操作均通过 RedisService 执行, key 从 CACHE_KEYS 统一获取.
 * Redis 异常时记录 WARN 日志, 不抛出异常 (优雅降级).
 */
@Injectable()
export class DistributedCacheService {
  private readonly logger = new Logger(DistributedCacheService.name);

  constructor(private readonly redisService: RedisService) { }

  /**
   * @description 将 groupId 标准化为 Redis key 片段.
   * @param groupId 用户组 ID; null 表示历史/全局资源池
   * @returns Redis key 中使用的用户组片段
   */
  buildGroupKey(groupId?: number | null): string {
    return groupId === null || groupId === undefined ? 'global' : `g${groupId}`;
  }

  // ==================== 用户组业务活跃心跳 ====================

  /**
   * @description 标记用户组最近有业务使用.
   *
   * GiftCardChecker/GiftCardExchanger 在请求入口写入该心跳; Property 后台任务
   * 扫描活跃组后再决定是否补齐查询上下文 warm pool。该写入是幂等的, 只更新最近使用时间。
   *
   * @param groupId 用户组 ID; null 表示历史/全局资源池
   * @param source 业务来源, 如 gift-card-checker 或 gift-card-exchanger
   * @param ttlMs Hash 保留 TTL 毫秒数
   * @sideEffects 写入 Redis Hash 和 ZSet 索引
   */
  async touchGroupActivity(
    groupId: number | null | undefined,
    source: string,
    ttlMs: number = GROUP_ACTIVITY_TTL_MS,
  ): Promise<void> {
    const groupKey = this.buildGroupKey(groupId);
    const redisKey = CACHE_KEYS.GROUP_ACTIVITY.build(groupKey);
    const now = Date.now();
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));

    try {
      const pipeline = this.redisService.getClient().pipeline();
      pipeline.hset(
        redisKey,
        'groupKey', groupKey,
        'groupId', groupId === null || groupId === undefined ? '' : String(groupId),
        'source', source,
        'lastSeenAt', String(now),
        'updatedAt', String(now),
      );
      pipeline.expire(redisKey, ttlSeconds);
      pipeline.zadd(CACHE_KEYS.GROUP_ACTIVITY_INDEX, now, groupKey);
      await pipeline.exec();
    } catch (error: any) {
      this.logger.warn(`[cache] 用户组活跃心跳写入失败: group=${groupKey}, source=${source} — ${error.message}`);
    }
  }

  /**
   * @description 读取仍处于业务活跃窗口内的用户组.
   *
   * 调用时会按 score 清理过期索引成员; 如果 Hash 已过期但 ZSet 仍有成员,
   * 当前结果会跳过该用户组, 后续扫描会继续清理。
   *
   * @param idleMs 空闲窗口毫秒数; lastSeenAt 早于 now-idleMs 视为不活跃
   * @returns 活跃用户组心跳快照列表
   */
  async getActiveGroupActivities(idleMs: number): Promise<SerializedGroupActivity[]> {
    const now = Date.now();
    const cutoff = now - Math.max(1, idleMs);

    try {
      const client = this.redisService.getClient();
      await client.zremrangebyscore(CACHE_KEYS.GROUP_ACTIVITY_INDEX, 0, cutoff - 1);
      const groupKeys = await client.zrangebyscore(CACHE_KEYS.GROUP_ACTIVITY_INDEX, cutoff, '+inf');
      if (groupKeys.length === 0) return [];

      const pipeline = client.pipeline();
      for (const groupKey of groupKeys) {
        pipeline.hgetall(CACHE_KEYS.GROUP_ACTIVITY.build(groupKey));
      }

      const results = await pipeline.exec();
      if (!results) return [];

      const activities: SerializedGroupActivity[] = [];
      for (const [err, data] of results) {
        if (err || !data || typeof data !== 'object') continue;
        const record = data as Record<string, string>;
        const lastSeenAt = Number.parseInt(record.lastSeenAt || '0', 10);
        if (!record.groupKey || !Number.isFinite(lastSeenAt) || lastSeenAt < cutoff) {
          continue;
        }

        activities.push({
          groupKey: record.groupKey,
          groupId: record.groupId ? Number(record.groupId) : null,
          source: record.source || 'unknown',
          lastSeenAt,
        });
      }

      return activities;
    } catch (error: any) {
      this.logger.warn(`[cache] 用户组活跃心跳读取失败: ${error.message}`);
      return [];
    }
  }

  // ==================== Session 缓存 ====================

  /**
   * @description 存储已初始化的 session 到 Redis.
   *
   * @param cacheKey 缓存 key (格式: `email:countryURL`)
   * @param data 序列化后的 session 数据
   * @param ttlMs TTL 毫秒数 (如 SESSION_CACHE_TTL_MS = 480000)
   */
  async saveSession(
    cacheKey: string,
    data: SerializedSession,
    ttlMs: number,
  ): Promise<void> {
    const redisKey = CACHE_KEYS.SESSION.build(cacheKey);
    const ttlSeconds = Math.ceil(ttlMs / 1000);

    try {
      const json = JSON.stringify(data);
      await this.redisService.set(redisKey, json, ttlSeconds);
      // this.logger.debug(
      //   `[cache] ✓ session 已存储: key=${cacheKey}, ttl=${ttlSeconds}s, size=${json.length}B`,
      // );
    } catch (error: any) {
      this.logger.warn(`[cache] session 存储失败: key=${cacheKey} — ${error.message}`);
    }
  }

  /**
   * @description 从 Redis 读取缓存的 session.
   *
   * @param cacheKey 缓存 key
   * @returns 反序列化的 session 数据, 不存在或异常返回 null
   */
  async getSession(cacheKey: string): Promise<SerializedSession | null> {
    const redisKey = CACHE_KEYS.SESSION.build(cacheKey);

    try {
      const json = await this.redisService.get(redisKey);
      if (!json) return null;

      return JSON.parse(json) as SerializedSession;
    } catch (error: any) {
      this.logger.warn(`[cache] session 读取失败: key=${cacheKey} — ${error.message}`);
      return null;
    }
  }

  /**
   * @description 淘汰缓存的 session.
   *
   * @param cacheKey 缓存 key
   */
  async evictSession(cacheKey: string): Promise<void> {
    const redisKey = CACHE_KEYS.SESSION.build(cacheKey);

    try {
      await this.redisService.del(redisKey);
      this.logger.debug(`[cache] session 已淘汰: key=${cacheKey}`);
    } catch (error: any) {
      this.logger.warn(`[cache] session 淘汰失败: key=${cacheKey} — ${error.message}`);
    }
  }

  /**
   * @description 批量淘汰多个 session — 一次 pipeline 完成, 幂等安全.
   *
   * 无需事先查询 key 是否存在, DEL 不存在的 key 是 no-op.
   *
   * @param cacheKeys 缓存 key 列表 (格式: `email:countryURL`)
   */
  async batchEvictSessions(cacheKeys: string[]): Promise<void> {
    if (cacheKeys.length === 0) return;

    try {
      const pipeline = this.redisService.getClient().pipeline();
      for (const key of cacheKeys) {
        pipeline.del(CACHE_KEYS.SESSION.build(key));
      }
      await pipeline.exec();
      // this.logger.debug(`[cache] 批量淘汰 session: ${cacheKeys.length} 个 key`);
    } catch (error: any) {
      this.logger.warn(`[cache] 批量淘汰失败: ${error.message}`);
    }
  }

  /**
   * @description 检查 session 缓存是否存在 (不反序列化, 仅检查存在性).
   *
   * @param cacheKey 缓存 key
   * @returns 存在且未过期返回 true
   */
  async hasValidSession(cacheKey: string): Promise<boolean> {
    const redisKey = CACHE_KEYS.SESSION.build(cacheKey);

    try {
      return await this.redisService.exists(redisKey);
    } catch (error: any) {
      this.logger.warn(`[cache] session 检查失败: key=${cacheKey} — ${error.message}`);
      return false;
    }
  }

  /**
   * @description 批量检查多个 session 缓存的存在性 — 用于 selectBestAccount 优化.
   *
   * 使用 Redis pipeline 批量查询, 避免 N 次 RTT.
   *
   * @param cacheKeys 缓存 key 列表
   * @returns 每个 key 的存在性布尔数组 (与输入顺序一致)
   */
  async batchHasSession(cacheKeys: string[]): Promise<boolean[]> {
    if (cacheKeys.length === 0) return [];

    try {
      const pipeline = this.redisService.getClient().pipeline();
      for (const key of cacheKeys) {
        pipeline.exists(CACHE_KEYS.SESSION.build(key));
      }

      const results = await pipeline.exec();
      if (!results) return cacheKeys.map(() => false);

      return results.map(([err, val]) => {
        if (err) return false;
        return val === 1;
      });
    } catch (error: any) {
      this.logger.warn(`[cache] 批量检查失败: ${error.message}`);
      return cacheKeys.map(() => false);
    }
  }

  // ==================== 使用统计 ====================

  /**
   * @description 记录 session 查询使用 — 原子更新计数器和时间戳.
   *
   * 使用 Redis Hash 存储, HINCRBY 原子递增查询次数.
   * 时间窗口过期时自动重置计数器.
   *
   * @param cacheKey 缓存 key
   * @param windowMs 时间窗口毫秒数
   * @returns 当前统计数据
   */
  async recordUsage(
    cacheKey: string,
    windowMs: number,
  ): Promise<SerializedUsageStats> {
    const redisKey = CACHE_KEYS.USAGE.build(cacheKey);
    const now = Date.now();
    const ttlSeconds = Math.ceil(windowMs / 1000) + 10; // 额外 10s 缓冲

    try {
      // 读取当前统计
      const existing = await this.redisService.hgetall(redisKey);
      const windowStart = parseInt(existing?.windowStart || '0', 10);
      const windowExpired = !windowStart || (now - windowStart) > windowMs;

      if (windowExpired) {
        // 窗口过期 — 重置计数器
        const pipeline = this.redisService.getClient().pipeline();
        pipeline.hset(redisKey, 'queryCount', '1');
        pipeline.hset(redisKey, 'windowStart', String(now));
        pipeline.hset(redisKey, 'lastQueryAt', String(now));
        pipeline.expire(redisKey, ttlSeconds);
        await pipeline.exec();

        return { queryCount: 1, windowStart: now, lastQueryAt: now };
      }

      // 窗口内 — 原子递增
      const pipeline = this.redisService.getClient().pipeline();
      pipeline.hincrby(redisKey, 'queryCount', 1);
      pipeline.hset(redisKey, 'lastQueryAt', String(now));
      const results = await pipeline.exec();

      const newCount = results?.[0]?.[1] as number || 1;
      return { queryCount: newCount, windowStart, lastQueryAt: now };
    } catch (error: any) {
      this.logger.warn(`[cache] 使用统计更新失败: key=${cacheKey} — ${error.message}`);
      return { queryCount: 1, windowStart: now, lastQueryAt: now };
    }
  }

  /**
   * @description 读取 session 使用统计.
   *
   * @param cacheKey 缓存 key
   * @returns 统计数据, 不存在返回 null
   */
  async getUsageStats(cacheKey: string): Promise<SerializedUsageStats | null> {
    const redisKey = CACHE_KEYS.USAGE.build(cacheKey);

    try {
      const data = await this.redisService.hgetall(redisKey);
      if (!data || !data.queryCount) return null;

      return {
        queryCount: parseInt(data.queryCount, 10),
        windowStart: parseInt(data.windowStart || '0', 10),
        lastQueryAt: parseInt(data.lastQueryAt || '0', 10),
      };
    } catch (error: any) {
      this.logger.warn(`[cache] 使用统计读取失败: key=${cacheKey} — ${error.message}`);
      return null;
    }
  }

  // ==================== 账号池 ====================

  /**
   * @description 存储账号池条目到 Redis — 跨 Pod 共享.
   *
   * 同时将 email 加入账号集合, 便于枚举所有账号.
   *
   * @param email 账号邮箱 (小写)
   * @param entry 序列化的账号数据
   * @param ttlSeconds TTL 秒数 (默认 24h)
   */
  async saveAccount(
    email: string,
    entry: SerializedPoolEntry,
    ttlSeconds: number = 24 * 3600,
  ): Promise<void> {
    const redisKey = CACHE_KEYS.ACCOUNT.build(email);

    try {
      const pipeline = this.redisService.getClient().pipeline();

      // 将每个字段存入 Hash
      const fields: Record<string, string> = {
        groupId: entry.groupId === null || entry.groupId === undefined ? '' : String(entry.groupId),
        email: entry.email,
        password: entry.password,
        region: entry.region,
        usageCount: String(entry.usageCount),
        lastUsedAt: String(entry.lastUsedAt),
        status: entry.status,
      };

      // 可选字段
      if (entry.twoFAUrl) fields.twoFAUrl = entry.twoFAUrl;
      if (entry.sessionId) fields.sessionId = entry.sessionId;
      if (entry.creditDisplay) fields.creditDisplay = entry.creditDisplay;
      if (entry.name) fields.name = entry.name;
      if (entry.errorMessage) fields.errorMessage = entry.errorMessage;

      // 批量写入 Hash 字段
      const flatArgs: string[] = [];
      for (const [k, v] of Object.entries(fields)) {
        flatArgs.push(k, v);
      }
      pipeline.hset(redisKey, ...flatArgs);
      pipeline.expire(redisKey, ttlSeconds);

      // 加入 email 集合
      pipeline.sadd(CACHE_KEYS.ACCOUNT_SET, email);
      pipeline.sadd(CACHE_KEYS.ACCOUNT_GROUP_SET.build(this.buildGroupKey(entry.groupId)), email);

      await pipeline.exec();
      this.logger.debug(`[cache] 账号已存储: ${email}, status=${entry.status}`);
    } catch (error: any) {
      this.logger.warn(`[cache] 账号存储失败: ${email} — ${error.message}`);
    }
  }

  /**
   * @description 从 Redis 读取单个账号信息.
   *
   * @param email 账号邮箱
   * @returns 账号数据, 不存在返回 null
   */
  async getAccount(email: string): Promise<SerializedPoolEntry | null> {
    const redisKey = CACHE_KEYS.ACCOUNT.build(email);

    try {
      const data = await this.redisService.hgetall(redisKey);
      if (!data || !data.email) return null;

      return {
        email: data.email,
        groupId: data.groupId ? Number(data.groupId) : null,
        password: data.password || '',
        twoFAUrl: data.twoFAUrl || undefined,
        sessionId: data.sessionId || undefined,
        region: data.region || 'unknown',
        creditDisplay: data.creditDisplay || undefined,
        name: data.name || undefined,
        usageCount: parseInt(data.usageCount || '0', 10),
        lastUsedAt: parseInt(data.lastUsedAt || '0', 10),
        status: (data.status as SerializedPoolEntry['status']) || 'unused',
        errorMessage: data.errorMessage || undefined,
      };
    } catch (error: any) {
      this.logger.warn(`[cache] 账号读取失败: ${email} — ${error.message}`);
      return null;
    }
  }

  /**
   * @description 获取所有已注册的账号邮箱列表.
   *
   * @returns email 数组
   */
  async getAllAccountEmails(): Promise<string[]> {
    try {
      const members = await this.redisService.getClient().smembers(CACHE_KEYS.ACCOUNT_SET);
      return members || [];
    } catch (error: any) {
      this.logger.warn(`[cache] 账号列表读取失败: ${error.message}`);
      return [];
    }
  }

  /**
   * @description 获取指定用户组的账号身份列表.
   * @param groupId 用户组 ID; null 表示历史/全局资源池
   * @returns 账号身份数组
   */
  async getAccountEmailsByGroup(groupId?: number | null): Promise<string[]> {
    const groupKey = this.buildGroupKey(groupId);

    try {
      const members = await this.redisService.getClient().smembers(CACHE_KEYS.ACCOUNT_GROUP_SET.build(groupKey));
      return members || [];
    } catch (error: any) {
      this.logger.warn(`[cache] 用户组账号列表读取失败: group=${groupKey} — ${error.message}`);
      return [];
    }
  }

  /**
   * @description 获取活跃账号数 — 仅计数 status='active' 且有 sessionId 的账号.
   *
   * 比 getAllAccounts() 轻量: 仅用 pipeline 读取 status + sessionId 两个字段,
   * 不反序列化完整的 PoolEntry, 避免了 N×HGETALL 全字段拉取.
   *
   * 适用于初始化地区并发信号量等仅需 count 的场景.
   *
   * @returns 活跃账号数量
   */
  async getActiveAccountCount(groupId?: number | null): Promise<number> {
    try {
      const emails = groupId === undefined ? await this.getAllAccountEmails() : await this.getAccountEmailsByGroup(groupId);
      if (emails.length === 0) return 0;

      // Pipeline 仅读取 status + sessionId — 2 个字段, 而非全量 HGETALL (~10 字段)
      const pipeline = this.redisService.getClient().pipeline();
      for (const email of emails) {
        pipeline.hmget(CACHE_KEYS.ACCOUNT.build(email), 'status', 'sessionId');
      }

      const results = await pipeline.exec();
      if (!results) return 0;

      let count = 0;
      for (const [err, fields] of results) {
        if (err) continue;
        const [status, sessionId] = fields as [string | null, string | null];
        if (status === 'active' && sessionId) count++;
      }

      return count;
    } catch (error: any) {
      this.logger.warn(`[cache] 活跃账号计数失败: ${error.message}`);
      return 0;
    }
  }

  /**
   * @description 批量获取所有账号的完整信息.
   *
   * 使用 pipeline 批量查询, 避免 N 次 RTT.
   *
   * @returns 所有账号数据数组
   */
  async getAllAccounts(groupId?: number | null): Promise<SerializedPoolEntry[]> {
    try {
      const emails = groupId === undefined ? await this.getAllAccountEmails() : await this.getAccountEmailsByGroup(groupId);
      if (emails.length === 0) return [];

      const pipeline = this.redisService.getClient().pipeline();
      for (const email of emails) {
        pipeline.hgetall(CACHE_KEYS.ACCOUNT.build(email));
      }

      const results = await pipeline.exec();
      if (!results) return [];

      const accounts: SerializedPoolEntry[] = [];
      for (const [err, data] of results) {
        if (err || !data || typeof data !== 'object') continue;
        const d = data as Record<string, string>;
        if (!d.email) continue;

        accounts.push({
          email: d.email,
          groupId: d.groupId ? Number(d.groupId) : null,
          password: d.password || '',
          twoFAUrl: d.twoFAUrl || undefined,
          sessionId: d.sessionId || undefined,
          region: d.region || 'unknown',
          creditDisplay: d.creditDisplay || undefined,
          name: d.name || undefined,
          usageCount: parseInt(d.usageCount || '0', 10),
          lastUsedAt: parseInt(d.lastUsedAt || '0', 10),
          status: (d.status as SerializedPoolEntry['status']) || 'unused',
          errorMessage: d.errorMessage || undefined,
        });
      }

      return accounts;
    } catch (error: any) {
      this.logger.warn(`[cache] 批量账号读取失败: ${error.message}`);
      return [];
    }
  }

  /**
   * @description 读取可用于地区检测的 active session 候选账号.
   *
   * 地区检测只需要 sessionId、usageCount 和日志邮箱, 因此这里用 HMGET 拉取最小字段,
   * 避免高并发检测轮询反复执行全字段 HGETALL。
   *
   * @param groupId 用户组 ID; null 表示历史/全局资源池
   * @returns 可参与地区检测的账号候选列表
   */
  async getActiveSessionCandidates(groupId?: number | null): Promise<SerializedActiveSessionCandidate[]> {
    try {
      const accountKeys = groupId === undefined
        ? await this.getAllAccountEmails()
        : await this.getAccountEmailsByGroup(groupId);
      if (accountKeys.length === 0) return [];

      const pipeline = this.redisService.getClient().pipeline();
      for (const accountKey of accountKeys) {
        pipeline.hmget(
          CACHE_KEYS.ACCOUNT.build(accountKey),
          'email',
          'sessionId',
          'status',
          'region',
          'usageCount',
        );
      }

      const results = await pipeline.exec();
      if (!results) return [];

      const candidates: SerializedActiveSessionCandidate[] = [];
      for (let index = 0; index < results.length; index++) {
        const [err, fields] = results[index];
        if (err || !Array.isArray(fields)) continue;

        const [email, sessionId, status, region, usageCount] = fields as Array<string | null>;
        if (status !== 'active' || !sessionId) continue;

        candidates.push({
          accountKey: accountKeys[index],
          email: email || accountKeys[index],
          sessionId,
          region: region || 'unknown',
          usageCount: parseInt(usageCount || '0', 10),
        });
      }

      return candidates;
    } catch (error: any) {
      this.logger.warn(`[cache] active session 候选读取失败: ${error.message}`);
      return [];
    }
  }

  /**
   * @description 更新账号的部分字段 — 不覆盖未提供的字段.
   *
   * @param email 账号邮箱
   * @param fields 要更新的字段
   */
  async updateAccountFields(
    email: string,
    fields: Partial<Record<string, string>>,
  ): Promise<void> {
    const redisKey = CACHE_KEYS.ACCOUNT.build(email);

    try {
      const flatArgs: string[] = [];
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) {
          flatArgs.push(k, v);
        }
      }
      if (flatArgs.length > 0) {
        await this.redisService.getClient().hset(redisKey, ...flatArgs);
      }
    } catch (error: any) {
      this.logger.warn(`[cache] 账号字段更新失败: ${email} — ${error.message}`);
    }
  }

  /**
   * @description 从 Redis 移除账号 — 删除 Hash + 从 Set 移除.
   *
   * @param email 账号邮箱
   */
  async removeAccount(email: string): Promise<void> {
    const redisKey = CACHE_KEYS.ACCOUNT.build(email);

    try {
      const pipeline = this.redisService.getClient().pipeline();
      pipeline.del(redisKey);
      pipeline.srem(CACHE_KEYS.ACCOUNT_SET, email);
      const data = await this.redisService.hgetall(redisKey);
      const groupId = data?.groupId ? Number(data.groupId) : null;
      pipeline.srem(CACHE_KEYS.ACCOUNT_GROUP_SET.build(this.buildGroupKey(groupId)), email);
      await pipeline.exec();
      this.logger.debug(`[cache] 账号已移除: ${email}`);
    } catch (error: any) {
      this.logger.warn(`[cache] 账号移除失败: ${email} — ${error.message}`);
    }
  }

  /**
   * @description 清除所有账号 — 删除所有 Hash + 清空 Set.
   */
  async clearAllAccounts(groupId?: number | null): Promise<void> {
    try {
      const emails = groupId === undefined ? await this.getAllAccountEmails() : await this.getAccountEmailsByGroup(groupId);

      if (emails.length > 0) {
        const pipeline = this.redisService.getClient().pipeline();
        for (const email of emails) {
          pipeline.del(CACHE_KEYS.ACCOUNT.build(email));
          pipeline.del(CACHE_KEYS.ACCOUNT_USAGE.build(email));
          pipeline.srem(CACHE_KEYS.ACCOUNT_SET, email);
        }
        if (groupId === undefined) {
          pipeline.del(CACHE_KEYS.ACCOUNT_SET);
        } else {
          pipeline.del(CACHE_KEYS.ACCOUNT_GROUP_SET.build(this.buildGroupKey(groupId)));
        }
        await pipeline.exec();
      }

      this.logger.log(`[cache] ✓ 已清除所有账号: ${emails.length} 个`);
    } catch (error: any) {
      this.logger.warn(`[cache] 批量清除账号失败: ${error.message}`);
    }
  }

  // ==================== 登录预热任务状态 ====================

  /**
   * @description 创建批量登录 + 预热任务摘要.
   * @param summary 任务摘要
   * @param ttlSeconds 任务状态 TTL 秒数
   */
  async createLoginWarmupJob(
    summary: SerializedLoginWarmupJobSummary,
    ttlSeconds: number = 24 * 3600,
  ): Promise<void> {
    await this.updateLoginWarmupJob(summary.jobId, summary, ttlSeconds);
  }

  /**
   * @description 更新批量登录 + 预热任务摘要字段.
   * @param jobId 任务 ID
   * @param fields 要写入的字段
   * @param ttlSeconds 任务状态 TTL 秒数
   */
  async updateLoginWarmupJob(
    jobId: string,
    fields: Partial<SerializedLoginWarmupJobSummary>,
    ttlSeconds: number = 24 * 3600,
  ): Promise<void> {
    const redisKey = CACHE_KEYS.LOGIN_WARMUP_JOB_SUMMARY.build(jobId);
    const payload: Record<string, string> = {};

    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        payload[key] = value === null ? '' : String(value);
      }
    }

    payload.updatedAt = String(fields.updatedAt ?? Date.now());

    if (Object.keys(payload).length === 0) return;

    const pipeline = this.redisService.getClient().pipeline();
    pipeline.hset(redisKey, payload);
    pipeline.expire(redisKey, ttlSeconds);
    await pipeline.exec();
  }

  /**
   * @description 原子递增批量登录 + 预热任务计数字段.
   * @param jobId 任务 ID
   * @param increments 计数字段增量
   * @param fields 同步写入的普通字段
   */
  async incrementLoginWarmupJob(
    jobId: string,
    increments: Partial<Record<keyof SerializedLoginWarmupJobSummary, number>>,
    fields: Partial<SerializedLoginWarmupJobSummary> = {},
  ): Promise<void> {
    const redisKey = CACHE_KEYS.LOGIN_WARMUP_JOB_SUMMARY.build(jobId);
    const pipeline = this.redisService.getClient().pipeline();

    for (const [key, value] of Object.entries(increments)) {
      if (typeof value === 'number' && value !== 0) {
        pipeline.hincrby(redisKey, key, value);
      }
    }

    const payload: Record<string, string> = { updatedAt: String(Date.now()) };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        payload[key] = value === null ? '' : String(value);
      }
    }
    pipeline.hset(redisKey, payload);
    pipeline.expire(redisKey, 24 * 3600);
    await pipeline.exec();
  }

  // ==================== 账号检测互斥锁 ====================

  /**
   * @description 尝试获取账号检测互斥锁 — 原子 SETNX, 防止并发请求获取同一账号.
   *
   * 用于 acquireAnySession: 获取账号时加锁, 检测完成后释放.
   * 同一时刻只有一个请求能锁定某账号, 后续请求自动跳到下一个账号.
   *
   * @param email 账号邮箱
   * @param ttlSeconds 锁超时秒数 (默认 30s, 防死锁)
   * @returns true=获取成功, false=已被其他请求持有
   */
  async tryAcquireDetectLock(email: string, ttlSeconds: number = 30): Promise<boolean> {
    try {
      const key = CACHE_KEYS.DETECT_LOCK.build(email);
      const result = await this.redisService.getClient().set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error: any) {
      this.logger.warn(`[cache] 检测锁获取失败: email=${email} — ${error.message}`);
      // Redis 异常时降级: 允许通过 (不因锁服务故障阻塞业务)
      return true;
    }
  }

  /**
   * @description 释放账号检测互斥锁.
   *
   * @param email 账号邮箱
   */
  async releaseDetectLock(email: string): Promise<void> {
    try {
      const key = CACHE_KEYS.DETECT_LOCK.build(email);
      await this.redisService.getClient().del(key);
    } catch (error: any) {
      this.logger.warn(`[cache] 检测锁释放失败: email=${email} — ${error.message}`);
    }
  }

  // ==================== 通用 ====================

  /**
   * @description 批量检查多个 key 的锁状态 — 用于 selectBestAccount 优化.
   *
   * @param cacheKeys 缓存 key 列表
   * @returns 每个 key 的锁状态布尔数组
   */
  async batchIsLocked(cacheKeys: string[]): Promise<boolean[]> {
    if (cacheKeys.length === 0) return [];

    try {
      const pipeline = this.redisService.getClient().pipeline();
      for (const key of cacheKeys) {
        pipeline.exists(CACHE_KEYS.LOCK.build(key));
      }

      const results = await pipeline.exec();
      if (!results) return cacheKeys.map(() => false);

      return results.map(([err, val]) => {
        if (err) return false;
        return val === 1;
      });
    } catch (error: any) {
      this.logger.warn(`[cache] 批量锁检查失败: ${error.message}`);
      return cacheKeys.map(() => false);
    }
  }

  // ==================== 地区级预热锁 ====================

  /**
   * @description 尝试获取地区级预热锁 — 原子 SETNX, 防止多账号同时预热同一地区.
   *
   * 与 email:region 粒度的 LOCK 不同, 此锁粒度为 region,
   * 确保同一地区在同一时刻只有一个账号在执行预热.
   *
   * @param regionPath 地区路径 (如 '/us')
   * @param email 执行预热的账号邮箱 (用于日志追踪)
   * @param ttlSeconds 锁超时秒数 (默认 60s, 防死锁)
   * @returns true=获取成功, false=已被其他账号持有
   */
  async tryAcquireWarmupRegion(
    regionPath: string,
    email: string,
    ttlSeconds: number = 60,
  ): Promise<boolean> {
    try {
      const key = CACHE_KEYS.WARMUP_REGION.build(regionPath);
      const result = await this.redisService.getClient().set(key, email, 'EX', ttlSeconds, 'NX');

      return result === 'OK';
    } catch (error: any) {
      this.logger.warn(`[cache] 地区预热锁获取失败: region=${regionPath} — ${error.message}`);
      return false;
    }
  }

  /**
   * @description 释放地区级预热锁.
   *
   * @param regionPath 地区路径
   */
  async releaseWarmupRegion(regionPath: string): Promise<void> {
    try {
      const key = CACHE_KEYS.WARMUP_REGION.build(regionPath);
      await this.redisService.getClient().del(key);
    } catch (error: any) {
      this.logger.warn(`[cache] 地区预热锁释放失败: region=${regionPath} — ${error.message}`);
    }
  }

  /**
   * @description 批量检查多个地区是否正在被预热 — 用于预热任务分配时跳过已占用地区.
   *
   * @param regionPaths 地区路径列表
   * @returns 每个地区的预热状态布尔数组 (与输入顺序一致)
   */
  async batchIsRegionBeingWarmed(regionPaths: string[]): Promise<boolean[]> {
    if (regionPaths.length === 0) return [];

    try {
      const pipeline = this.redisService.getClient().pipeline();
      for (const regionPath of regionPaths) {
        pipeline.exists(CACHE_KEYS.WARMUP_REGION.build(regionPath));
      }

      const results = await pipeline.exec();
      if (!results) return regionPaths.map(() => false);

      return results.map(([err, val]) => {
        if (err) return false;
        return val === 1;
      });
    } catch (error: any) {
      this.logger.warn(`[cache] 批量地区预热检查失败: ${error.message}`);
      return regionPaths.map(() => false);
    }
  }

  // ==================== 地区级已预热账号索引 (SET) ====================

  /**
   * @description 将账号加入地区预热索引集合 — SADD, 支持多账号.
   *
   * 每次 saveToCache 时调用, 将完成初始化的账号加入 SET.
   * TTL 与 session 缓存对齐, 确保 session 过期时索引自动清除.
   *
   * 并发分发时, getWarmedAccounts 返回所有候选, 配合 batchIsLocked
   * 过滤正在使用的账号, 实现并发请求分散到不同账号.
   *
   * @param regionPath 地区路径 (如 '/us')
   * @param email 拥有该地区预热 session 的账号邮箱
   * @param ttlMs TTL 毫秒数 (应与 SESSION_CACHE_TTL_MS 一致)
   */
  async setWarmedAccount(
    regionPath: string,
    email: string,
    ttlMs: number,
  ): Promise<void> {
    const redisKey = CACHE_KEYS.WARMED_ACCOUNT.build(regionPath);
    const ttlSeconds = Math.ceil(ttlMs / 1000);

    try {
      const pipeline = this.redisService.getClient().pipeline();
      pipeline.sadd(redisKey, email);
      pipeline.expire(redisKey, ttlSeconds);
      await pipeline.exec();
      // this.logger.debug(
      //   `[cache] ✓ 地区预热索引已写入: region=${regionPath}, email=${email}, ttl=${ttlSeconds}s`,
      // );
    } catch (error: any) {
      this.logger.warn(
        `[cache] 地区预热索引写入失败: region=${regionPath} — ${error.message}`,
      );
    }
  }

  /**
   * @description 获取某地区所有已预热 session 的账号列表 — SMEMBERS.
   *
   * 返回所有候选账号, 由调用方结合锁状态和冷却状态筛选最优账号.
   *
   * @param regionPath 地区路径
   * @returns 已预热该地区的账号邮箱数组, 无候选时返回空数组
   */
  async getWarmedAccounts(regionPath: string): Promise<string[]> {
    const redisKey = CACHE_KEYS.WARMED_ACCOUNT.build(regionPath);

    try {
      const members = await this.redisService.getClient().smembers(redisKey);
      return members || [];
    } catch (error: any) {
      this.logger.warn(
        `[cache] 地区预热索引读取失败: region=${regionPath} — ${error.message}`,
      );
      return [];
    }
  }

  /**
   * @description 从地区预热索引中移除单个账号 — SREM.
   *
   * session 淘汰时调用, 仅移除该账号, 不影响同地区的其他已预热账号.
   * 保持索引与 session 缓存的一致性.
   *
   * @param regionPath 地区路径
   * @param email 要移除的账号邮箱
   */
  async removeWarmedAccountMember(
    regionPath: string,
    email: string,
  ): Promise<void> {
    const redisKey = CACHE_KEYS.WARMED_ACCOUNT.build(regionPath);

    try {
      await this.redisService.getClient().srem(redisKey, email);
      // this.logger.debug(
      //   `[cache] 地区预热索引已移除成员: region=${regionPath}, email=${email}`,
      // );
    } catch (error: any) {
      this.logger.warn(
        `[cache] 地区预热索引成员移除失败: region=${regionPath} — ${error.message}`,
      );
    }
  }

  // ==================== 账号-地区绑定反向索引 ====================

  /**
   * @description 设置账号当前绑定的地区 — 强制唯一, 覆盖旧值.
   *
   * saveToCache 调用时写入, 确保同一时刻一个账号只有一个地区上下文。
   * 当账号从旧地区切换到新地区时, 同步删除旧地区 session 和 warmed set 成员,
   * 避免旧索引让后续预热容量判断误以为该账号仍可服务旧地区。
   *
   * @param email 账号邮箱
   * @param regionPath 地区路径 (如 '/us')
   * @param ttlMs TTL 毫秒数 (应与 SESSION_CACHE_TTL_MS 一致)
   * @sideEffects 写入账号地区绑定; 必要时删除旧地区 session 和预热索引成员
   */
  async setAccountRegion(
    email: string,
    regionPath: string,
    ttlMs: number,
  ): Promise<void> {
    const accountIdentity = email.toLowerCase();
    const redisKey = CACHE_KEYS.ACCOUNT_REGION.build(accountIdentity);
    const ttlSeconds = Math.ceil(ttlMs / 1000);

    try {
      const previousRegionPath = await this.redisService.get(redisKey);
      const pipeline = this.redisService.getClient().pipeline();
      pipeline.set(redisKey, regionPath, 'EX', ttlSeconds);

      if (previousRegionPath && previousRegionPath !== regionPath) {
        pipeline.del(CACHE_KEYS.SESSION.build(`${accountIdentity}:${previousRegionPath}`));
        pipeline.srem(CACHE_KEYS.WARMED_ACCOUNT.build(previousRegionPath), accountIdentity);
      }

      await pipeline.exec();
    } catch (error: any) {
      this.logger.warn(
        `[cache] 账号地区绑定设置失败: email=${email}, region=${regionPath} — ${error.message}`,
      );
    }
  }

  /**
   * @description 获取账号当前绑定的地区.
   *
   * @param email 账号邮箱
   * @returns 绑定的地区路径, 不存在返回 null
   */
  async getAccountRegion(email: string): Promise<string | null> {
    const redisKey = CACHE_KEYS.ACCOUNT_REGION.build(email.toLowerCase());

    try {
      return await this.redisService.get(redisKey);
    } catch (error: any) {
      this.logger.warn(`[cache] 账号地区绑定读取失败: email=${email} — ${error.message}`);
      return null;
    }
  }

  /**
   * @description 删除账号的地区绑定 — evictCache 时调用, 释放账号供其他地区使用.
   *
   * @param email 账号邮箱
   */
  async deleteAccountRegion(email: string): Promise<void> {
    const redisKey = CACHE_KEYS.ACCOUNT_REGION.build(email.toLowerCase());

    try {
      await this.redisService.getClient().del(redisKey);
    } catch (error: any) {
      this.logger.warn(`[cache] 账号地区绑定删除失败: email=${email} — ${error.message}`);
    }
  }

  /**
   * @description 批量获取多个账号的当前绑定地区 — pipeline, 1 RTT.
   *
   * 用于 getAccountForRegion 兜底扫描: 过滤已绑定其他地区的账号.
   *
   * @param emails 账号邮箱列表
   * @returns 每个账号绑定的地区路径数组 (null 表示未绑定, 与输入顺序一致)
   */
  async batchGetAccountRegions(emails: string[]): Promise<(string | null)[]> {
    if (emails.length === 0) return [];

    try {
      const pipeline = this.redisService.getClient().pipeline();
      for (const email of emails) {
        pipeline.get(CACHE_KEYS.ACCOUNT_REGION.build(email.toLowerCase()));
      }

      const results = await pipeline.exec();
      if (!results) return emails.map(() => null);

      return results.map(([err, val]) => {
        if (err || !val) return null;
        return val as string;
      });
    } catch (error: any) {
      this.logger.warn(`[cache] 批量账号地区绑定查询失败: ${error.message}`);
      return emails.map(() => null);
    }
  }

  /**
   * @description 清空某地区的整个预热索引 — DEL, 全量清理.
   *
   * 仅在需要完全重置地区索引时使用 (如地区级故障恢复).
   *
   * @param regionPath 地区路径
   */
  async clearWarmedAccounts(regionPath: string): Promise<void> {
    const redisKey = CACHE_KEYS.WARMED_ACCOUNT.build(regionPath);

    try {
      await this.redisService.getClient().del(redisKey);
      this.logger.debug(`[cache] 地区预热索引已清空: region=${regionPath}`);
    } catch (error: any) {
      this.logger.warn(
        `[cache] 地区预热索引清空失败: region=${regionPath} — ${error.message}`,
      );
    }
  }

  // ==================== 账号冷却锁 ====================

  /**
   * @description 设置账号冷却锁 — 查询达到阈值后冷却, 期间不可初始化或查询.
   *
   * 使用 SET EX NX 原子操作, 幂等安全.
   *
   * @param cacheKey 缓存 key (email:region)
   * @param ttlSeconds 冷却时长 (秒, 默认 60)
   */
  async setCooldownLock(cacheKey: string, ttlSeconds: number = 60): Promise<void> {
    const redisKey = CACHE_KEYS.COOLDOWN.build(cacheKey);

    try {
      await this.redisService.getClient().set(redisKey, '1', 'EX', ttlSeconds);
      this.logger.log(`[cache] 冷却锁已设置: key=${cacheKey}, ttl=${ttlSeconds}s`);
    } catch (error: any) {
      this.logger.warn(`[cache] 冷却锁设置失败: key=${cacheKey} — ${error.message}`);
    }
  }

  /**
   * @description 检查账号是否处于冷却期.
   *
   * @param cacheKey 缓存 key (email:region)
   * @returns true = 冷却中 (不可使用), false = 可用
   */
  async isCoolingDown(cacheKey: string): Promise<boolean> {
    const redisKey = CACHE_KEYS.COOLDOWN.build(cacheKey);

    try {
      return await this.redisService.exists(redisKey);
    } catch (error: any) {
      this.logger.warn(`[cache] 冷却状态检查失败: key=${cacheKey} — ${error.message}`);
      return false;
    }
  }

  /**
   * @description 批量检查多个账号的冷却状态 — pipeline 优化, 一次 RTT.
   *
   * @param cacheKeys 缓存 key 列表
   * @returns 每个 key 的冷却状态布尔数组 (与输入顺序一致)
   */
  async batchIsCoolingDown(cacheKeys: string[]): Promise<boolean[]> {
    if (cacheKeys.length === 0) return [];

    try {
      const pipeline = this.redisService.getClient().pipeline();
      for (const key of cacheKeys) {
        pipeline.exists(CACHE_KEYS.COOLDOWN.build(key));
      }

      const results = await pipeline.exec();
      if (!results) return cacheKeys.map(() => false);

      return results.map(([err, val]) => {
        if (err) return false;
        return val === 1;
      });
    } catch (error: any) {
      this.logger.warn(`[cache] 批量冷却检查失败: ${error.message}`);
      return cacheKeys.map(() => false);
    }
  }

  // ==================== 地区级并发信号量 ====================

  /**
   * @description 初始化/刷新地区并发信号量 — 设置最大可用槽位数.
   *
   * 已存在的信号量会按容量差值扩容/缩容, 不会直接覆盖当前剩余槽位.
   * 这样账号池从 1 个扩到 40 个时, 旧的低容量 key 会立即补足可用槽位,
   * 同时保留当前正在执行的查询占用数.
   *
   * @param regionPath 地区路径
   * @param maxSlots 最大并发槽位数 (= 该地区可用账号数)
   * @param ttlSeconds TTL 秒数 (默认 300s, 自动过期防残留)
   */
  async initRegionSlots(
    regionPath: string,
    maxSlots: number,
    ttlSeconds: number = 300,
  ): Promise<void> {
    const redisKey = CACHE_KEYS.REGION_SLOTS.build(regionPath);
    const capacityKey = CACHE_KEYS.REGION_SLOT_CAPACITY.build(regionPath);

    const resizeScript = `
      local slotsKey = KEYS[1]
      local capacityKey = KEYS[2]
      local newCapacity = tonumber(ARGV[1])
      local ttlSeconds = tonumber(ARGV[2])
      local currentValue = redis.call("get", slotsKey)
      local oldCapacityValue = redis.call("get", capacityKey)

      if not currentValue then
        redis.call("set", slotsKey, newCapacity, "EX", ttlSeconds)
        redis.call("set", capacityKey, newCapacity, "EX", ttlSeconds)
        return newCapacity
      end

      local currentSlots = tonumber(currentValue) or 0
      local oldCapacity = tonumber(oldCapacityValue) or currentSlots
      local inUse = oldCapacity - currentSlots
      if inUse < 0 then
        inUse = 0
      end

      local nextSlots = newCapacity - inUse
      if nextSlots < 0 then
        nextSlots = 0
      end

      redis.call("set", slotsKey, nextSlots, "EX", ttlSeconds)
      redis.call("set", capacityKey, newCapacity, "EX", ttlSeconds)
      return nextSlots
    `;

    try {
      await this.redisService.getClient().eval(
        resizeScript,
        2,
        redisKey,
        capacityKey,
        String(maxSlots),
        String(ttlSeconds),
      );
    } catch (error: any) {
      this.logger.warn(`[cache] 地区信号量初始化失败: region=${regionPath} — ${error.message}`);
    }
  }

  /**
   * @description 尝试获取地区查询槽位 — Lua 原子检查并扣减, 成功返回 true.
   *
   * 仅当当前剩余槽位 > 0 时扣减, 避免 DECR 后再 INCR 的短暂负数漂移.
   *
   * @param regionPath 地区路径
   * @returns true = 获取成功, false = 无可用槽位
   */
  async acquireRegionSlot(regionPath: string): Promise<boolean> {
    const redisKey = CACHE_KEYS.REGION_SLOTS.build(regionPath);

    try {
      const acquireScript = `
        local currentValue = redis.call("get", KEYS[1])
        if not currentValue then
          return -1
        end

        local currentSlots = tonumber(currentValue) or 0
        if currentSlots <= 0 then
          return -2
        end

        return redis.call("decr", KEYS[1])
      `;
      const remaining = await this.redisService.getClient().eval(acquireScript, 1, redisKey);
      return Number(remaining) >= 0;
    } catch (error: any) {
      // Redis 异常时降级: 允许通过 (不因锁服务故障阻塞业务)
      this.logger.warn(`[cache] 地区槽位获取异常: region=${regionPath} — ${error.message}`);
      return true;
    }
  }

  /**
   * @description 释放地区查询槽位 — 原子有上限 INCR.
   *
   * @param regionPath 地区路径
   */
  async releaseRegionSlot(regionPath: string): Promise<void> {
    const redisKey = CACHE_KEYS.REGION_SLOTS.build(regionPath);
    const capacityKey = CACHE_KEYS.REGION_SLOT_CAPACITY.build(regionPath);

    const releaseScript = `
      local currentValue = redis.call("get", KEYS[1])
      local capacityValue = redis.call("get", KEYS[2])
      if not currentValue then
        return 0
      end

      local currentSlots = tonumber(currentValue) or 0
      local capacity = tonumber(capacityValue)
      if capacity and currentSlots >= capacity then
        return currentSlots
      end

      return redis.call("incr", KEYS[1])
    `;

    try {
      await this.redisService.getClient().eval(releaseScript, 2, redisKey, capacityKey);
    } catch (error: any) {
      this.logger.warn(`[cache] 地区槽位释放失败: region=${regionPath} — ${error.message}`);
    }
  }
}
