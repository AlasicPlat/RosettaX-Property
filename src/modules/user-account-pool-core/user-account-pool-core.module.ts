import { Module } from '@nestjs/common';
import { UserAccountPoolIdentityService } from './user-account-pool-identity.service';

/**
 * @description 用户账号池核心规则模块.
 *
 * 只维护跨账号池子模块共享的身份 key 和 storefront 地区解析规则。
 */
@Module({
  providers: [UserAccountPoolIdentityService],
  exports: [UserAccountPoolIdentityService],
})
export class UserAccountPoolCoreModule {}
