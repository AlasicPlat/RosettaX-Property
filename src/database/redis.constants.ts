/**
 * @description Redis 注入令牌定义文件.
 *
 * 独立于 database.module.ts 和 redis.service.ts,
 * 避免两者之间的循环导入导致 Symbol 在装饰器执行时为 undefined.
 *
 * 背景: database.module.ts 导入 RedisService, redis.service.ts 又导入 REDIS_CLIENT,
 * CommonJS 循环引用解析时 REDIS_CLIENT 尚未被赋值, 导致 @Inject(undefined) 报错:
 * "Nest can't resolve dependencies of the RedisService (?)"
 */

/** Redis 客户端注入令牌 — 用于 @Inject(REDIS_CLIENT) */
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
