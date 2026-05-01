import { Module } from '@nestjs/common';
import { AccountSessionWarmupModule } from '../account-session-warmup/account-session-warmup.module';
import { DistributedCacheModule } from '../distributed-cache/distributed-cache.module';
import { UserAccountPoolLoginModule } from '../user-account-pool-login/user-account-pool-login.module';
import { AccountSessionRefreshService } from './account-session-refresh.service';

/**
 * @description 账号查询 session 主动刷新模块.
 *
 * 根据 RosettaX 主服务写入的业务活跃心跳, 在 Property 侧周期性补齐
 * active 用户组的查询上下文 warm pool, 空闲超时后自然停止。
 */
@Module({
  imports: [DistributedCacheModule, AccountSessionWarmupModule, UserAccountPoolLoginModule],
  providers: [AccountSessionRefreshService],
})
export class AccountSessionRefreshModule { }
