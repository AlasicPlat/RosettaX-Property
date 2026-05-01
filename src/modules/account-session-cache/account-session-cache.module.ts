import { Module } from '@nestjs/common';
import { DistributedCacheModule } from '../distributed-cache/distributed-cache.module';
import { HttpProxyModule } from '../http-proxy/http-proxy.module';
import { AccountSessionCacheService } from './account-session-cache.service';

/**
 * @description 账号查询 session 缓存模块.
 *
 * 职责:
 * - 序列化/反序列化 Apple Store 查询上下文和 Cookie
 * - 维护 Redis session 缓存
 * - 维护地区预热索引和账号地区反向索引
 */
@Module({
  imports: [DistributedCacheModule, HttpProxyModule],
  providers: [AccountSessionCacheService],
  exports: [AccountSessionCacheService],
})
export class AccountSessionCacheModule { }
