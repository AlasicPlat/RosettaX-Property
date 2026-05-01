import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * @description Redis 操作封装服务 — 提供类型安全的常用 Redis 命令.
 *
 * 设计意图: 业务模块不直接操作原始 ioredis 实例, 统一通过本服务调用,
 * 便于后续添加日志、监控、序列化策略等横切关注点.
 * 实现 OnModuleDestroy 生命周期钩子, 应用关闭时优雅断开 Redis 连接.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // ─── String 类型操作 ────────────────────────────────

  /**
   * @description 获取指定 key 的值
   * @param key Redis 键名
   * @returns 键对应的值, 不存在则返回 null
   */
  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  /**
   * @description 设置 key-value, 可选过期时间
   * @param key Redis 键名
   * @param value 存储值
   * @param ttlSeconds 可选的 TTL (秒). 不传则永不过期
   */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.redis.setex(key, ttlSeconds, value);
    } else {
      await this.redis.set(key, value);
    }
  }

  /**
   * @description 删除指定的一个或多个 key
   * @param keys 待删除的键名列表
   * @returns 实际删除的键数量
   */
  async del(...keys: string[]): Promise<number> {
    return this.redis.del(...keys);
  }

  // ─── Hash 类型操作 ─────────────────────────────────

  /**
   * @description 设置 Hash 中某个 field 的值
   * @param key Hash 键名
   * @param field 字段名
   * @param value 字段值
   */
  async hset(key: string, field: string, value: string): Promise<void> {
    await this.redis.hset(key, field, value);
  }

  /**
   * @description 获取 Hash 中某个 field 的值
   * @param key Hash 键名
   * @param field 字段名
   * @returns 字段值, 不存在返回 null
   */
  async hget(key: string, field: string): Promise<string | null> {
    return this.redis.hget(key, field);
  }

  /**
   * @description 获取 Hash 中全部 field-value 对
   * @param key Hash 键名
   * @returns 完整的 field-value 映射
   */
  async hgetall(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(key);
  }

  /**
   * @description 删除 Hash 中指定的字段
   * @param key Hash 键名
   * @param fields 待删除的字段列表
   * @returns 实际被删除的字段数量
   */
  async hdel(key: string, ...fields: string[]): Promise<number> {
    return this.redis.hdel(key, ...fields);
  }

  // ─── 通用操作 ──────────────────────────────────────

  /**
   * @description 检查 key 是否存在
   * @param key Redis 键名
   * @returns 存在返回 true
   */
  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key);
    return result === 1;
  }

  /**
   * @description 设置 key 的过期时间
   * @param key Redis 键名
   * @param ttlSeconds 过期时间 (秒)
   */
  async expire(key: string, ttlSeconds: number): Promise<void> {
    await this.redis.expire(key, ttlSeconds);
  }

  /**
   * @description 获取原始 ioredis 实例 — 用于需要 pipeline / multi 等高级操作的场景
   * @returns ioredis 客户端实例
   */
  getClient(): Redis {
    return this.redis;
  }

  /**
   * @description 应用关闭时优雅断开 Redis 连接, 避免连接泄漏
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('正在关闭 Redis 连接...');
    await this.redis.quit();
    this.logger.log('✓ Redis 连接已关闭');
  }
}
