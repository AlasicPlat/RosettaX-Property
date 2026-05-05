import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { RedisService } from '../../database/redis.service';

/** Redis Lua 脚本: 原子获取全局 Apple 初始化并发槽位. */
const ACQUIRE_SLOT_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], 0, tonumber(ARGV[1]) - tonumber(ARGV[3]))
local members = redis.call("ZRANGE", KEYS[1], 0, -1)
local current = #members
local maxConcurrency = tonumber(ARGV[2])
local reserveSlots = tonumber(ARGV[5])
local realtimeBurstSlots = tonumber(ARGV[6])
local priority = ARGV[7]
local backgroundCount = 0
for _, member in ipairs(members) do
  if string.sub(member, 1, 9) ~= "realtime:" then
    backgroundCount = backgroundCount + 1
  end
end
local backgroundLimit = maxConcurrency - reserveSlots
if backgroundLimit < 1 then
  backgroundLimit = 1
end
local allowedTotal = maxConcurrency
if priority == "realtime" and backgroundCount >= backgroundLimit then
  allowedTotal = maxConcurrency + realtimeBurstSlots
end
if priority == "background" then
  if current < maxConcurrency and backgroundCount < backgroundLimit then
    redis.call("ZADD", KEYS[1], ARGV[1], ARGV[4])
    redis.call("EXPIRE", KEYS[1], math.ceil(tonumber(ARGV[3]) / 1000))
    return 1
  end
  return 0
end
if current < allowedTotal then
  redis.call("ZADD", KEYS[1], ARGV[1], ARGV[4])
  redis.call("EXPIRE", KEYS[1], math.ceil(tonumber(ARGV[3]) / 1000))
  return 1
end
return 0
`;

export type AppleInitializationPriority = 'realtime' | 'background';

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

/**
 * @description Apple 登录/查询上下文初始化的跨 Pod 全局并发限制器.
 *
 * BullMQ 只控制单队列/单 worker 的消费并发, 但 Apple 登录和 GiftCard 查询
 * 初始化都属于外部重资源操作。该服务用 Redis zset 实现分布式 semaphore,
 * 确保多 Property Pod 扩容后不会同时打爆代理或 Apple 风控链路。
 */
@Injectable()
export class AppleInitializationLimiterService {
  private readonly logger = new Logger(AppleInitializationLimiterService.name);
  private readonly limiterKey = process.env.ROSETTAX_PROPERTY_APPLE_INIT_LIMITER_KEY || 'rx:limiter:apple-init';
  private readonly maxConcurrency = parsePositiveIntEnv('ROSETTAX_PROPERTY_APPLE_INIT_GLOBAL_CONCURRENCY', 4);
  private readonly slotTtlMs = parsePositiveIntEnv('ROSETTAX_PROPERTY_APPLE_INIT_SLOT_TTL_MS', 10 * 60 * 1000);
  private readonly realtimeReserveSlots = parsePositiveIntEnv('ROSETTAX_PROPERTY_APPLE_INIT_REALTIME_RESERVED_SLOTS', 1);
  private readonly realtimeBurstSlots = parsePositiveIntEnv('ROSETTAX_PROPERTY_APPLE_INIT_REALTIME_BURST_SLOTS', 1);
  private readonly realtimeWaitMs = parsePositiveIntEnv('ROSETTAX_PROPERTY_APPLE_INIT_REALTIME_WAIT_MS', 80);
  private readonly backgroundWaitMs = parsePositiveIntEnv('ROSETTAX_PROPERTY_APPLE_INIT_BACKGROUND_WAIT_MS', 300);
  private readonly backgroundWaitLogIntervalMs = parsePositiveIntEnv(
    'ROSETTAX_PROPERTY_APPLE_INIT_BACKGROUND_WAIT_LOG_MS',
    5_000,
  );

  /**
   * @description 注入 Redis 连接.
   * @param redisService 全局 Redis 服务
   */
  constructor(private readonly redisService: RedisService) { }

  /**
   * @description 在全局并发闸门内执行 Apple 初始化相关操作.
   * @param label 操作标签, 用于日志定位
   * @param priority 优先级; 后台任务等待间隔更长, 避免持续抢占实时任务
   * @param handler 实际业务处理函数
   * @returns handler 的返回值
   * @sideEffects 临时写入 Redis 并发槽位, 完成后释放
   */
  async run<T>(
    label: string,
    priority: AppleInitializationPriority,
    handler: () => Promise<T>,
  ): Promise<T> {
    const token = `${priority}:${hostname()}-${process.pid}-${randomUUID()}`;
    const startedAt = Date.now();
    await this.acquireSlot(token, label, priority);
    try {
      return await handler();
    } finally {
      await this.redisService.getClient().zrem(this.limiterKey, token).catch((error: any) => {
        this.logger.warn(`[apple-init-limiter] 槽位释放失败: label=${label}, error=${error.message}`);
      });
      const elapsed = Date.now() - startedAt;
      if (elapsed > this.slotTtlMs * 0.8) {
        this.logger.warn(`[apple-init-limiter] 操作耗时接近槽位 TTL: label=${label}, elapsed=${elapsed}ms`);
      }
    }
  }

  /**
   * @description 循环等待并获取一个全局并发槽位.
   *
   * background 任务最多占用 `maxConcurrency - realtimeReserveSlots` 个槽位, 避免大批量
   * 账号预热把兑换登录、2FA 等用户实时链路完全堵住。若历史 background token 已经占满
   * 全局槽位, realtime 允许使用少量 burst 槽位恢复可用性。
   *
   * @param token 当前任务槽位 token
   * @param label 操作标签
   * @param priority 优先级
   * @sideEffects 写入 Redis zset 槽位
   */
  private async acquireSlot(token: string, label: string, priority: AppleInitializationPriority): Promise<void> {
    const waitMs = priority === 'background' ? this.backgroundWaitMs : this.realtimeWaitMs;
    const startedAt = Date.now();
    let lastBackgroundWaitLogAt = 0;

    while (true) {
      const acquired = await this.redisService.getClient().eval(
        ACQUIRE_SLOT_SCRIPT,
        1,
        this.limiterKey,
        Date.now(),
        this.maxConcurrency,
        this.slotTtlMs,
        token,
        this.realtimeReserveSlots,
        this.realtimeBurstSlots,
        priority,
      );
      if (acquired === 1) return;
      await this.sleep(waitMs);
      lastBackgroundWaitLogAt = this.logBackgroundSlotWaitIfNeeded(
        priority,
        label,
        startedAt,
        lastBackgroundWaitLogAt,
      );
    }
  }

  /**
   * @description 按固定间隔输出后台任务等待槽位日志, 避免高并发预热时每轮等待都刷屏.
   * @param priority 当前任务优先级
   * @param label 操作标签
   * @param startedAt 开始等待的时间戳
   * @param lastLogAt 上次输出等待日志的时间戳
   * @returns 更新后的上次输出日志时间戳
   * @sideEffects 后台任务达到日志间隔时写入 Nest debug 日志
   */
  private logBackgroundSlotWaitIfNeeded(
    priority: AppleInitializationPriority,
    label: string,
    startedAt: number,
    lastLogAt: number,
  ): number {
    if (priority !== 'background') return lastLogAt;

    const now = Date.now();
    if (lastLogAt > 0 && now - lastLogAt < this.backgroundWaitLogIntervalMs) {
      return lastLogAt;
    }

    this.logger.debug(
      `[apple-init-limiter] 后台任务等待槽位: label=${label}, ` +
      `waited=${now - startedAt}ms, maxConcurrency=${this.maxConcurrency}`,
    );
    return now;
  }

  /**
   * @description 等待指定毫秒数.
   * @param milliseconds 等待时间
   * @returns 延迟 Promise
   */
  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
