/**
 * @file index.ts
 * @description 分布式缓存模块 — barrel export.
 */
export { DistributedCacheModule } from './distributed-cache.module';
export { DistributedCacheService } from './distributed-cache.service';
export { DistributedLockService, LockHandle } from './distributed-lock.service';
export { CACHE_KEYS } from '../../constants/cache-keys.constants';
export {
  SerializedSession,
  SerializedContext,
  SerializedAccountInfo,
  SerializedUsageStats,
  SerializedPoolEntry,
  SerializedGroupActivity,
  SerializedLoginWarmupJobSummary,
} from './interfaces/serialized-session.interface';
