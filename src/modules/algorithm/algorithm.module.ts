import { Module } from '@nestjs/common';
import { FingerprintService } from './fingerprint.service';
import { HttpProxyModule } from '../http-proxy/http-proxy.module';
import { ShldV0Service } from './shld-v0.service';
import { ShldV1Service } from './shld-v1.service';
import { ShldDispatcherService } from './shld-dispatcher.service';

/**
 * @description 算法模块 — 为账号上下文初始化提供浏览器指纹与 SHLD PoW 能力.
 */
@Module({
  imports: [HttpProxyModule],
  providers: [FingerprintService, ShldV0Service, ShldV1Service, ShldDispatcherService],
  exports: [FingerprintService, ShldV0Service, ShldV1Service, ShldDispatcherService],
})
export class AlgorithmModule {}
