import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { RedisService } from '../../database/redis.service';
import { MessageQueueName } from './message-queue.constants';

/**
 * @description 消息消费处理函数.
 */
export type MessageHandler<TPayload> = (payload: TPayload, context: MessageContext) => Promise<void>;

/**
 * @description 消息消费上下文.
 */
export interface MessageContext {
  /** 底层消息 ID. */
  id: string;
  /** 消息名称. */
  name: string;
  /** 队列名称. */
  queueName: string;
  /** 当前重试次数. */
  attemptsMade: number;
}

/**
 * @description 消费者注册参数.
 */
export interface ConsumeMessageOptions {
  /** 当前进程消费并发度. */
  concurrency: number;
}

/**
 * @description 消息队列消费服务.
 *
 * 业务消费者只依赖该抽象注册处理器, 不直接感知 BullMQ。后续切换 Kafka/RabbitMQ
 * 时保持 consume 语义不变, 只替换本服务内部适配实现。
 */
@Injectable()
export class MessageQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(MessageQueueService.name);
  private readonly workers: Worker[] = [];

  /**
   * @description 注入 Redis 连接.
   * @param redisService 全局 Redis 服务
   */
  constructor(private readonly redisService: RedisService) { }

  /**
   * @description 注册队列消费者.
   * @param queueName 队列名称
   * @param handler 业务消息处理函数
   * @param options 消费参数
   * @sideEffects 创建 BullMQ Worker 并开始消费
   */
  consume<TPayload>(
    queueName: MessageQueueName,
    handler: MessageHandler<TPayload>,
    options: ConsumeMessageOptions,
  ): void {
    const worker = new Worker<TPayload>(
      queueName,
      async (job: Job<TPayload>) => {
        await handler(job.data, {
          id: String(job.id || ''),
          name: job.name,
          queueName,
          attemptsMade: job.attemptsMade,
        });
      },
      {
        connection: this.redisService.getClient().duplicate({ maxRetriesPerRequest: null }),
        concurrency: Math.max(1, options.concurrency),
        lockDuration: this.parsePositiveIntEnv('ROSETTAX_PROPERTY_QUEUE_LOCK_DURATION_MS', 10 * 60 * 1000),
        stalledInterval: this.parsePositiveIntEnv('ROSETTAX_PROPERTY_QUEUE_STALLED_INTERVAL_MS', 30 * 1000),
        maxStalledCount: this.parsePositiveIntEnv('ROSETTAX_PROPERTY_QUEUE_MAX_STALLED_COUNT', 2),
      },
    );

    worker.on('failed', (job, error) => {
      this.logger.error(
        `[message-queue] 消息处理失败: queue=${queueName}, jobId=${job?.id || '(unknown)'}, ` +
        `name=${job?.name || '(unknown)'}, error=${error.message}`,
        error.stack,
      );
    });
    worker.on('error', (error) => {
      this.logger.error(`[message-queue] Worker 异常: queue=${queueName}, error=${error.message}`, error.stack);
    });
    worker.on('ready', () => {
      this.logger.log(`[message-queue] Worker 已启动: queue=${queueName}, concurrency=${Math.max(1, options.concurrency)}`);
    });

    this.workers.push(worker);
  }

  /**
   * @description 应用关闭时停止所有消费者.
   */
  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    this.logger.log('消息队列消费者已关闭');
  }

  /**
   * @description 解析正整数环境变量.
   * @param key 环境变量名
   * @param fallback 默认值
   * @returns 合法正整数或默认值
   */
  private parsePositiveIntEnv(key: string, fallback: number): number {
    const value = Number.parseInt(process.env[key] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }
}
