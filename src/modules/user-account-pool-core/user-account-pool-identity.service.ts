import { Injectable, Logger } from '@nestjs/common';

/**
 * storeFront ID → region 代码映射.
 *
 * Apple storeFront 格式: "143465-19,29"、"143441-1,29" 等。
 * 前缀数字是 storefront ID, 用于确定账号地区。
 */
const STOREFRONT_TO_REGION: Record<string, string> = {
  '143465': 'cn',
  '143441': 'us',
  '143462': 'jp',
  '143460': 'au',
  '143455': 'ca',
  '143443': 'de',
  '143442': 'fr',
  '143450': 'gb',
  '143449': 'it',
  '143454': 'es',
  '143466': 'kr',
  '143470': 'tw',
  '143463': 'hk',
  '143464': 'sg',
  '143467': 'in',
  '143469': 'br',
  '143468': 'mx',
  '143448': 'nl',
  '143456': 'se',
  '143457': 'no',
  '143458': 'dk',
  '143447': 'fi',
  '143459': 'ch',
  '143445': 'at',
  '143446': 'be',
  '143453': 'pt',
  '143461': 'nz',
  '143478': 'ru',
  '143451': 'pl',
  '143480': 'tr',
  '143479': 'za',
  '143475': 'th',
  '143473': 'my',
  '143474': 'ph',
  '143476': 'id',
  '143471': 'vn',
  '143481': 'ae',
  '143477': 'sa',
  '143491': 'il',
};

/**
 * @description 用户账号池身份 key 与地区解析服务.
 *
 * 该服务集中维护 group/email → Redis 身份 key 的规则, 避免不同业务服务
 * 各自拼接 key 导致 session、锁、账号池和预热索引不一致。
 */
@Injectable()
export class UserAccountPoolIdentityService {
  private readonly logger = new Logger(UserAccountPoolIdentityService.name);

  /**
   * @description 将 groupId 标准化为 Redis key 片段.
   * @param groupId 用户组 ID; null/undefined 表示历史全局资源池
   * @returns Redis key 使用的用户组片段
   */
  buildGroupKey(groupId?: number | null): string {
    return groupId === null || groupId === undefined ? 'global' : `g${groupId}`;
  }

  /**
   * @description 构建用户组内账号身份 key.
   * @param email Apple ID 邮箱
   * @param groupId 用户组 ID
   * @returns 账号身份 key, 格式为 {groupKey}|{email}
   */
  buildAccountIdentity(email: string, groupId?: number | null): string {
    return `${this.buildGroupKey(groupId)}|${email.toLowerCase()}`;
  }

  /**
   * @description 构建账号级预热锁 key.
   * @param accountIdentity 用户组内账号身份 key
   * @returns Redis 分布式锁业务 key
   */
  buildWarmupAccountLockKey(accountIdentity: string): string {
    return `warmup-account:${accountIdentity.toLowerCase()}`;
  }

  /**
   * @description 从 Apple storeFront 字符串解析地区代码.
   * @param storeFront Apple Store-Front 值
   * @returns 地区代码; 无法识别时返回 unknown
   */
  parseRegionFromStoreFront(storeFront: string): string {
    if (!storeFront) return 'unknown';

    const storefrontId = storeFront.split('-')[0]?.trim();
    if (storefrontId && STOREFRONT_TO_REGION[storefrontId]) {
      return STOREFRONT_TO_REGION[storefrontId];
    }

    this.logger.warn(`[UserPool] 无法识别 storeFront: ${storeFront}`);
    return 'unknown';
  }
}
