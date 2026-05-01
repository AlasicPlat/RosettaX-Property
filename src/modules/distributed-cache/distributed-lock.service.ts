import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../database/redis.service';
import { CACHE_KEYS } from '../../constants/cache-keys.constants';
import { v4 as uuidv4 } from 'uuid';

/**
 * @file distributed-lock.service.ts
 * @description 分布式锁服务 — 基于 Redis SETNX 实现跨 Pod 互斥.
 *
 * 用于替代单进程内存锁, 确保多 Pod 环境下同一 cacheKey 的初始化或查询串行执行.
 *
 * 实现:
 * - 加锁: `SET key lockId NX PX ttlMs`
 * - 释放: Lua 脚本原子检查 lockId + 删除 (防止误释放其他 Pod 的锁)
 * - 等待: 轮询模式 (100ms 间隔), 最大等待时间 30s
 *
 * 单 Redis 实例方案, 不使用 Redlock.
 * 如需多 Redis 节点, 后续可迁移到 ioredis Cluster + Redlock.
 */

/** 默认锁超时 (毫秒) — 防止死锁 */
const DEFAULT_LOCK_TTL_MS = 30_000;
/** 锁轮询间隔 (毫秒) */
const LOCK_POLL_INTERVAL_MS = 100;
/** 最大等待时间 (毫秒) */
const MAX_WAIT_MS = 60_000;

/**
 * @description Lua 脚本 — 原子释放锁.
 *
 * 逻辑: 如果 key 的值等于传入的 lockId, 则删除 key; 否则不操作.
 * 防止 Pod A 释放了 Pod B 的锁.
 */
const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/**
 * @description 锁句柄 — 持有者调用 release() 释放锁.
 */
export interface LockHandle {
  /** 锁标识符 (用于日志) */
  lockId: string;
  /** 释放锁 — 调用后其他等待者可获取 */
  release: () => Promise<void>;
}

@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  /** 当前 Pod 标识 — 用于 lockId 前缀, 便于调试追踪 */
  private readonly podId = `pod-${process.pid}`;

  constructor(private readonly redisService: RedisService) { }

  /**
   * @description 获取分布式锁 — 阻塞等待直到获取成功或超时.
   *
   * @param key 锁名称 (不含前缀, 会自动添加 CACHE_KEYS.LOCK 前缀)
   * @param ttlMs 锁的最大持有时间 (毫秒), 超过后自动释放 (防死锁)
   * @returns LockHandle — 包含 release() 方法
   * @throws Error 等待超时
   */
  async acquire(
    key: string,
    ttlMs: number = DEFAULT_LOCK_TTL_MS,
  ): Promise<LockHandle> {
    const redisKey = CACHE_KEYS.LOCK.build(key);
    const lockId = `${this.podId}:${uuidv4()}`;
    const startTime = Date.now();

    while (true) {
      // 尝试获取锁: SET key lockId NX PX ttlMs
      const result = await this.redisService.getClient().set(
        redisKey,
        lockId,
        'PX',
        ttlMs,
        'NX',
      );

      if (result === 'OK') {
        this.logger.debug(`[lock] ✓ 已获取锁: key=${key}, lockId=${lockId}`);
        return {
          lockId,
          release: () => this.release(key, lockId),
        };
      }

      // 检查超时
      const elapsed = Date.now() - startTime;
      if (elapsed >= MAX_WAIT_MS) {
        this.logger.warn(
          `[lock] ✘ 获取锁超时: key=${key}, 等待时间=${elapsed}ms`,
        );
        throw new Error(`分布式锁获取超时: key=${key}, 等待=${elapsed}ms`);
      }

      // 等待后重试
      await this.sleep(LOCK_POLL_INTERVAL_MS);
    }
  }

  /**
   * @description 尝试获取锁 — 非阻塞, 获取失败立即返回 null.
   *
   * @param key 锁名称
   * @param ttlMs 锁的最大持有时间
   * @returns LockHandle 或 null (已被其他 Pod 持有)
   */
  async tryAcquire(
    key: string,
    ttlMs: number = DEFAULT_LOCK_TTL_MS,
  ): Promise<LockHandle | null> {
    const redisKey = CACHE_KEYS.LOCK.build(key);
    const lockId = `${this.podId}:${uuidv4()}`;

    try {
      const result = await this.redisService.getClient().set(
        redisKey,
        lockId,
        'PX',
        ttlMs,
        'NX',
      );

      if (result === 'OK') {
        this.logger.debug(`[lock] ✓ 已获取锁 (tryAcquire): key=${key}`);
        return {
          lockId,
          release: () => this.release(key, lockId),
        };
      }

      return null;
    } catch (error: any) {
      this.logger.warn(`[lock] tryAcquire 异常: key=${key} — ${error.message}`);
      return null;
    }
  }

  /**
   * @description 检查锁是否被持有 — 用于 selectBestAccount 中的锁状态判断.
   *
   * @param key 锁名称
   * @returns true = 已锁定
   */
  async isLocked(key: string): Promise<boolean> {
    const redisKey = CACHE_KEYS.LOCK.build(key);

    try {
      return await this.redisService.exists(redisKey);
    } catch (error: any) {
      this.logger.warn(`[lock] isLocked 检查异常: key=${key} — ${error.message}`);
      return false;
    }
  }

  /**
   * @description 释放锁 — 使用 Lua 脚本原子操作, 仅释放自己持有的锁.
   *
   * @param key 锁名称
   * @param lockId 锁标识符 (acquire 时生成)
   */
  private async release(key: string, lockId: string): Promise<void> {
    const redisKey = CACHE_KEYS.LOCK.build(key);

    try {
      const result = await this.redisService.getClient().eval(
        RELEASE_LOCK_SCRIPT,
        1,
        redisKey,
        lockId,
      );

      if (result === 1) {
        this.logger.debug(`[lock] ✓ 锁已释放: key=${key}, lockId=${lockId}`);
      } else {
        this.logger.warn(
          `[lock] 锁释放失败 (已被其他持有者或已过期): key=${key}, lockId=${lockId}`,
        );
      }
    } catch (error: any) {
      this.logger.warn(`[lock] 锁释放异常: key=${key} — ${error.message}`);
    }
  }

  /**
   * @description 异步等待指定毫秒数.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
