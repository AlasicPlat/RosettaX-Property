import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { MessageQueueService } from './message-queue.service';

/**
 * @description 消息队列抽象模块.
 *
 * 当前底层实现为 BullMQ + Redis, 业务消费者不直接依赖具体消息框架。
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [MessageQueueService],
  exports: [MessageQueueService],
})
export class MessageQueueModule { }
