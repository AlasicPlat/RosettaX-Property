import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../../database/database.module';
import { AppleAccount } from '../../entities/apple-account.entity';
import { DistributedCacheModule } from '../distributed-cache/distributed-cache.module';
import { UserAccountPoolCoreModule } from '../user-account-pool-core/user-account-pool-core.module';
import { UserAccountPoolStateService } from './user-account-pool-state.service';

/**
 * @description 用户账号池状态模块.
 *
 * 负责账号池 Redis 状态、使用计数、过期标记、退出清理和状态查询。
 */
@Module({
  imports: [
    DatabaseModule,
    DistributedCacheModule,
    TypeOrmModule.forFeature([AppleAccount]),
    UserAccountPoolCoreModule,
  ],
  providers: [UserAccountPoolStateService],
  exports: [UserAccountPoolStateService],
})
export class UserAccountPoolStateModule {}
