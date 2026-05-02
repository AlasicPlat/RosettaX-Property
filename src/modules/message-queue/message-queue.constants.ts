/**
 * @description 业务消息队列名称.
 *
 * 名称必须与 RosettaX 投递端保持一致, 且不包含底层队列框架的特殊分隔符。
 */
export const MESSAGE_QUEUE_NAMES = {
  /** 用户账号实时队列: 登录、2FA、relogin、单账号上下文重建. */
  USER_ACCOUNT_REALTIME: 'rx-user-account-realtime',
  /** 用户账号后台队列: missing query account 等低优先级补容任务. */
  USER_ACCOUNT_BACKGROUND: 'rx-user-account-background',
} as const;

export type MessageQueueName = typeof MESSAGE_QUEUE_NAMES[keyof typeof MESSAGE_QUEUE_NAMES];
