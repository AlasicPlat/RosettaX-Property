import { Module } from '@nestjs/common';
import { ItunesClientService } from './itunes-client.service';
import { SessionManagerService } from './session-manager.service';
import { AccountModule } from '../account/account.module';
import { HttpProxyModule } from '../http-proxy/http-proxy.module';
import { ProxyModule } from '../proxy/proxy-pool.module';

/**
 * @description iTunes 客户端基础模块 — 封装 iTunes 协议翻译 + 会话管理.
 *
 * 提供的能力:
 * - ItunesClientService: 无状态 iTunes API 调用 (login / redeem / balance)
 * - SessionManagerService: 运行时会话管理 (内存池 + Redis 持久化 + Decodo 代理绑定)
 *
 * 模块依赖:
 * - AccountModule: MySQL 账号持久化 (AccountService)
 * - ProxyModule: Decodo 代理分配 (DecodoProxyService)
 * - HttpProxyModule: 代理请求发送
 * - DatabaseModule: Redis 操作 (全局模块, 自动注入)
 */
@Module({
  imports: [
    AccountModule,
    ProxyModule,
    HttpProxyModule,
  ],
  providers: [ItunesClientService, SessionManagerService],
  exports: [ItunesClientService, SessionManagerService],
})
export class ItunesClientModule { }
