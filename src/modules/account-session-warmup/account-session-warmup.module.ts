import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppleAccount } from '../../entities/apple-account.entity';
import { GroupWarmUpRecord } from '../../entities/group_warm_up_record.entity';
import { AccountSessionInitializerModule } from '../account-session-initializer/account-session-initializer.module';
import { AppleInitializationLimiterModule } from '../apple-initialization-limiter/apple-initialization-limiter.module';
import { DistributedCacheModule } from '../distributed-cache/distributed-cache.module';
import { UserAccountPoolCoreModule } from '../user-account-pool-core/user-account-pool-core.module';
import { AccountSessionWarmupService } from './account-session-warmup.service';

/**
 * @description 账号查询 session 预热模块.
 *
 * 职责:
 * - 监听批量登录完成事件
 * - 分配账号到地区预热槽位
 * - 按需补齐指定地区 ready session 容量
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AppleAccount, GroupWarmUpRecord]),
    AppleInitializationLimiterModule,
    DistributedCacheModule,
    AccountSessionInitializerModule,
    UserAccountPoolCoreModule,
  ],
  providers: [AccountSessionWarmupService],
  exports: [AccountSessionWarmupService],
})
export class AccountSessionWarmupModule { }
