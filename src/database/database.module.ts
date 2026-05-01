import { Global, Module, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisService } from './redis.service';
import { REDIS_CLIENT } from './redis.constants';

/**
 * @description 数据库基础设施模块 — 全局提供 Redis (ioredis) 连接.
 *
 * 设计意图: 作为全局共享模块, 通过自定义 Provider 创建 ioredis 实例,
 * 并通过 RedisService 封装常用操作, 供所有业务模块注入使用.
 * MySQL 连接由 TypeOrmModule.forRootAsync() 在 AppModule 中独立配置.
 *
 * 参考来源: @docs Java 版 DatabaseConfig.java 中的 Redis JedisPool 初始化逻辑
 *
 * 注意: REDIS_CLIENT 令牌从 redis.constants.ts 导入, 避免与 redis.service.ts 形成循环引用.
 */

// 重新导出令牌, 保持外部模块的导入路径兼容
export { REDIS_CLIENT } from './redis.constants';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService): Redis => {
        const logger = new Logger('DatabaseModule');

        const host = configService.get<string>('REDIS_HOST', '127.0.0.1');
        const port = configService.get<number>('REDIS_PORT', 6379);
        const db = configService.get<number>('REDIS_DB', 8);
        const password = configService.get<string>('REDIS_PASSWORD', 'redis123');

        const client = new Redis({
          host,
          port,
          db,
          password,
          maxRetriesPerRequest: 3,
          retryStrategy: (times: number) => {
            // 重连策略: 指数退避, 最大间隔 10 秒
            const delay = Math.min(times * 500, 10000);
            logger.warn(`Redis 连接重试 #${times}, ${delay}ms 后重连...`);
            return delay;
          },
        });

        client.on('connect', () => {
          logger.log(`✓ Redis 连接已建立: ${host}:${port}/db${db}`);
        });

        client.on('error', (err: Error) => {
          logger.error(`✘ Redis 连接异常: ${err.message}`);
        });

        return client;
      },
      inject: [ConfigService],
    },
    RedisService,
  ],
  exports: [REDIS_CLIENT, RedisService],
})
export class DatabaseModule {}
