import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppleAccount } from '../../entities/apple-account.entity';
import { AccountService } from './account.service';

/**
 * @description Apple 账号业务模块 — 管理 apple_account 表的 CRUD 操作.
 *
 * 注册 AppleAccount 实体到 TypeORM 仓库, 提供并导出 AccountService,
 * 供其他模块 (如登录流程、余额查询) 通过依赖注入使用.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AppleAccount])],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule { }
