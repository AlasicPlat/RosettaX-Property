import { Global, Module } from '@nestjs/common';
import { ProxyModule } from '../proxy/proxy-pool.module';
import { HttpProxyService } from './http-proxy.service';
import { CookieJarService } from './cookie-jar.service';

/**
 * @description HTTP 代理服务全局模块 — 提供带 SOCKS5 代理支持的 HTTP 请求能力.
 *
 * 设计意图: 作为全局模块, 任何业务模块可直接注入 HttpProxyService 发起代理请求,
 * 无需关心代理选取、Agent 构建、故障切换等底层细节.
 * 依赖 ProxyModule 获取当前启用的 ProxyProvider.
 */
@Global()
@Module({
  imports: [ProxyModule],
  providers: [HttpProxyService, CookieJarService],
  exports: [HttpProxyService, CookieJarService],
})
export class HttpProxyModule { }
