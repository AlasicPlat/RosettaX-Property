import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createMysqlOptions } from './database/mysql.config';
import { DatabaseModule } from './database/database.module';
import { DistributedCacheModule } from './modules/distributed-cache/distributed-cache.module';
import { AccountSessionWarmupModule } from './modules/account-session-warmup/account-session-warmup.module';
import { MessageQueueModule } from './modules/message-queue/message-queue.module';
import { UserAccountLoginTaskConsumerService } from './modules/user-account-login-queue/user-account-login-task-consumer.service';
import { UserAccountPoolLoginModule } from './modules/user-account-pool-login/user-account-pool-login.module';
import { UserAccountPoolCoreModule } from './modules/user-account-pool-core/user-account-pool-core.module';

/**
 * @description RosettaX-Property 独立账号处理应用模块.
 *
 * 该服务不承接业务查询 HTTP 流量, 只消费 RosettaX 主服务写入消息队列的
 * 账号登录、2FA、relogin 和查询上下文初始化任务, 并把账号池/session
 * 状态写回共享 Redis 与 MySQL。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../RosettaX/.env'],
    }),
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: createMysqlOptions,
    }),
    DatabaseModule,
    DistributedCacheModule,
    MessageQueueModule,
    UserAccountPoolCoreModule,
    UserAccountPoolLoginModule,
    AccountSessionWarmupModule,
  ],
  providers: [UserAccountLoginTaskConsumerService],
})
export class PropertyModule { }
