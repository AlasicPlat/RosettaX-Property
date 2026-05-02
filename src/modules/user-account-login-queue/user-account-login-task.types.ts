import {
  LoginWarmupAccountInput,
  LoginWarmupOperator,
} from '../user-account-pool-core/user-account-pool.types';

/**
 * @description RosettaX 主服务投递到 Redis Stream 的账号初始化任务契约.
 *
 * 该类型必须与 RosettaX 中 UserAccountLoginQueueService 发布的 payload 保持兼容。
 * RosettaX-Property 只消费任务, 不负责创建任务。
 */
export type LoginQueueTask =
  | {
    /** 批量账号登录和查询 session 预热任务 */
    type: 'login_warmup';
    /** 登录预热 job summary ID */
    jobId: string;
    /** 待登录账号 */
    accounts: LoginWarmupAccountInput[];
    /** 可选指定预热地区 */
    warmupRegions?: string[];
    /** 操作者上下文 */
    operator?: LoginWarmupOperator;
    /** 用户组 ID */
    groupId: number;
    /** 任务创建时间戳 */
    requestedAt: number;
  }
  | {
    /** 手动提交 2FA 验证码任务 */
    type: 'submit_2fa';
    /** 登录预热 job summary ID */
    jobId: string;
    /** Apple ID 邮箱 */
    email: string;
    /** 6 位验证码 */
    code: string;
    /** 用户组 ID */
    groupId: number | null;
    /** 任务创建时间戳 */
    requestedAt: number;
  }
  | {
    /** GiftCardExchanger 兑换账号登录任务 */
    type: 'exchange_login';
    /** 兑换账号登录 job summary ID */
    jobId: string;
    /** 待登录兑换账号 */
    accounts: LoginWarmupAccountInput[];
    /** 用户组 ID */
    groupId: number | null;
    /** 任务创建时间戳 */
    requestedAt: number;
  }
  | {
    /** 单账号后台 relogin 任务 */
    type: 'relogin';
    /** 用户组内账号身份 key */
    accountKey: string;
    /** Apple ID 邮箱 */
    email: string;
    /** Apple ID 密码 */
    password: string;
    /** 可选 2FA 接收地址 */
    twoFAUrl?: string;
    /** 用户组 ID */
    groupId: number | null;
    /** 调度原因 */
    reason: string;
    /** 任务创建时间戳 */
    requestedAt: number;
    /** RosettaX 投递锁 token, Property 处理完成后用它精确释放锁 */
    dedupeToken?: string;
  }
  | {
    /** 按用户组 DB 账号和已保存预热地区增量补齐查询 session */
    type: 'group_warmup';
    /** 用户组 ID */
    groupId: number | null;
    /** 当前业务缺失的地区路径 */
    requestedRegion?: string;
    /** 当前需要直接重建上下文的账号; 缺省时只做用户组容量补齐 */
    requestedAccount?: {
      email: string;
      password: string;
      accountKey?: string;
      groupId?: number | null;
    };
    /** 调度原因 */
    reason: string;
    /** 任务创建时间戳 */
    requestedAt: number;
    /** RosettaX 投递锁 token, Property 处理完成后用它精确释放锁 */
    dedupeToken?: string;
  };
