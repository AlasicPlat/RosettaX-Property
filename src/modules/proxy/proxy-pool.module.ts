import { Module, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DecodoProxyService } from './decodo-proxy.service';
import { IProyalProxyService } from './iproyal-proxy.service';
import { PROXY_PROVIDER } from './proxy-config.interface';

/**
 * @description 代理模块 — 提供旋转代理服务.
 *
 * 通过 PROXY_PROVIDER 环境变量动态选择代理服务商:
 *   - 'iproyal' (默认): IProyalProxyService
 *   - 'decodo': DecodoProxyService
 *
 * 消费者通过 @Inject(PROXY_PROVIDER) 获取 ProxyProvider 实例,
 * 无需关心底层是哪个服务商. 新增服务商只需:
 * 1. 创建 Service 实现 ProxyProvider 接口
 * 2. 在此 factory 中注册
 * 3. .env 中设置 PROXY_PROVIDER=xxx
 */
@Module({
  providers: [
    DecodoProxyService,
    IProyalProxyService,
    {
      provide: PROXY_PROVIDER,
      useFactory: (
        config: ConfigService,
        iproyal: IProyalProxyService,
        decodo: DecodoProxyService,
      ) => {
        const provider = config.get<string>('PROXY_PROVIDER', 'iproyal');
        const logger = new Logger('ProxyModule');
        logger.log(`✓ 代理服务商: ${provider.toUpperCase()}`);

        switch (provider) {
          case 'decodo':
            return decodo;
          case 'iproyal':
          default:
            return iproyal;
        }
      },
      inject: [ConfigService, IProyalProxyService, DecodoProxyService],
    },
  ],
  exports: [PROXY_PROVIDER, DecodoProxyService, IProyalProxyService],
})
export class ProxyModule {}
