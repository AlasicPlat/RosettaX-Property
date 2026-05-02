import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AppleInitializationLimiterService } from './apple-initialization-limiter.service';

/**
 * @description Apple 初始化并发限制模块.
 */
@Global()
@Module({
  imports: [DatabaseModule],
  providers: [AppleInitializationLimiterService],
  exports: [AppleInitializationLimiterService],
})
export class AppleInitializationLimiterModule { }
