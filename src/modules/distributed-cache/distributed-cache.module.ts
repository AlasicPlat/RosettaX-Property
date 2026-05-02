import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DistributedCacheService } from './distributed-cache.service';

/**
 * @description 分布式缓存模块 — 全局提供 Redis-based 缓存和统计服务.
 *
 * 职责:
 * 1. DistributedCacheService — session 缓存, 使用统计, 账号池共享
 * 作为全局模块注册, 所有业务模块可直接注入, 无需显式导入.
 *
 * 依赖:
 * - DatabaseModule (全局) — 提供 RedisService
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [DistributedCacheService],
  exports: [DistributedCacheService],
})
export class DistributedCacheModule {}
