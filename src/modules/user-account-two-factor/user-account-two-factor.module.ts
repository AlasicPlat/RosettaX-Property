import { Module } from '@nestjs/common';
import { HttpProxyModule } from '../http-proxy/http-proxy.module';
import { UserAccountTwoFactorService } from './user-account-two-factor.service';

/**
 * @description 用户账号 2FA 验证码获取模块.
 *
 * 仅封装 2FA URL 请求和验证码解析, 不处理账号池状态。
 */
@Module({
  imports: [HttpProxyModule],
  providers: [UserAccountTwoFactorService],
  exports: [UserAccountTwoFactorService],
})
export class UserAccountTwoFactorModule { }
