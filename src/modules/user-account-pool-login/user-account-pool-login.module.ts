import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DistributedCacheModule } from '../distributed-cache/distributed-cache.module';
import { ItunesClientModule } from '../itunes-client/itunes-client.module';
import { UserAccountPoolCoreModule } from '../user-account-pool-core/user-account-pool-core.module';
import { UserAccountPoolStateModule } from '../user-account-pool-state/user-account-pool-state.module';
import { UserAccountPoolLoginService } from './user-account-pool-login.service';

/**
 * @description 用户账号池登录模块.
 *
 * 负责批量登录、手动 2FA、登录预热任务和后台 relogin。
 */
@Module({
  imports: [
    DatabaseModule,
    DistributedCacheModule,
    ItunesClientModule,
    UserAccountPoolCoreModule,
    UserAccountPoolStateModule,
  ],
  providers: [UserAccountPoolLoginService],
  exports: [UserAccountPoolLoginService],
})
export class UserAccountPoolLoginModule {}
