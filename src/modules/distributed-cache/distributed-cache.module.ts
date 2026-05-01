import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DistributedCacheService } from './distributed-cache.service';
import { DistributedLockService } from './distributed-lock.service';

/**
 * @description 分布式缓存模块 — 全局提供 Redis-based 缓存、锁、统计服务.
 *
 * 职责:
 * 1. DistributedCacheService — session 缓存, 使用统计, 账号池共享
 * 2. DistributedLockService — 分布式互斥锁 (SETNX + Lua 释放)
 *
 * 作为全局模块注册, 所有业务模块可直接注入, 无需显式导入.
 *
 * 依赖:
 * - DatabaseModule (全局) — 提供 RedisService
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [DistributedCacheService, DistributedLockService],
  exports: [DistributedCacheService, DistributedLockService],
})
export class DistributedCacheModule {}
