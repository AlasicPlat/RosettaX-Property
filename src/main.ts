import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PropertyModule } from './property.module';

/**
 * @description 启动 RosettaX-Property 账号初始化 worker.
 *
 * 该进程只创建 Nest application context, 不监听 HTTP 端口。账号相关慢操作通过
 * Redis Stream 与 RosettaX 主服务解耦, 避免业务接口同步执行 Apple 登录和上下文初始化。
 *
 * @sideEffects 连接 MySQL/Redis 并启动 Redis Stream 消费循环
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('PropertyBootstrap');
  const app = await NestFactory.createApplicationContext(PropertyModule, {
    bufferLogs: true,
  });
  // Standalone application context will not auto-flush buffered Nest Logger output.
  // Without this, worker logs are hidden while TypeORM query logs still print.
  app.flushLogs();
  logger.log('RosettaX-Property account worker started');
}

bootstrap().catch((error: any) => {
  // eslint-disable-next-line no-console
  console.error(`RosettaX-Property failed to start: ${error.message}`, error.stack);
  process.exit(1);
});
