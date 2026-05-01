import { Module } from '@nestjs/common';
import { AlgorithmModule } from '../algorithm/algorithm.module';
import { AccountSessionCacheModule } from '../account-session-cache/account-session-cache.module';
import { DistributedCacheModule } from '../distributed-cache/distributed-cache.module';
import { HttpProxyModule } from '../http-proxy/http-proxy.module';
import { AccountSessionInitializerService } from './account-session-initializer.service';

/**
 * @description 账号查询上下文初始化模块.
 *
 * 该模块只封装 Apple 登录后初始化可复用查询 session 的慢链路能力, 不包含
 * 余额查询、兑换、记录写入等业务逻辑。
 */
@Module({
  imports: [
    AlgorithmModule,
    DistributedCacheModule,
    HttpProxyModule,
    AccountSessionCacheModule,
  ],
  providers: [AccountSessionInitializerService],
  exports: [AccountSessionInitializerService],
})
export class AccountSessionInitializerModule { }
