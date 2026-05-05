import { Injectable, Logger } from '@nestjs/common';
import { HttpProxyService } from '../http-proxy';

/**
 * @description 2FA 拉码选项.
 */
export interface FetchTwoFactorCodeOptions {
  /** 只接受不早于该时间的验证码; 用于避免提交旧短信验证码. */
  notBefore?: Date | number;
  /** 允许 provider 与服务端时钟存在的误差, 单位毫秒. */
  notBeforeSkewMs?: number;
}

/**
 * @description 从 2FA provider 响应中解析出的验证码元数据.
 */
interface ParsedTwoFactorPayload {
  /** 6 位验证码; 未识别到时为 null. */
  code: string | null;
  /** provider 返回的验证码时间戳; 无法识别时为 null. */
  codeTimeMs: number | null;
  /** 用于失败日志的可搜索文本. */
  searchableText: string;
}

/**
 * @description 用户账号 2FA 验证码获取服务.
 *
 * 仅负责从用户配置的 2FA URL 拉取响应并解析 6 位 Apple 验证码,
 * 不处理 Apple 登录状态或账号池状态更新。
 */
@Injectable()
export class UserAccountTwoFactorService {
  private readonly logger = new Logger(UserAccountTwoFactorService.name);

  constructor(private readonly httpProxy: HttpProxyService) { }

  /**
   * @description 从 2FA URL 获取验证码.
   * @param url 2FA 验证码获取 URL
   * @param options 拉码过滤选项; 可要求验证码时间不早于本次 Apple 2FA 挑战
   * @returns 6 位验证码字符串; 解析失败返回 null
   * @sideEffects 发起一次直连 HTTP GET 请求并记录成功/失败日志
   */
  async fetch2FACode(url: string, options: FetchTwoFactorCodeOptions = {}): Promise<string | null> {
    try {
      this.logger.log(`[UserPool] 获取 2FA 验证码: ${this.maskSensitiveUrl(url)}`);
      const response = await this.httpProxy.request({
        method: 'GET',
        url,
        useProxy: false,
        timeout: 10000,
      });

      const parsed = this.parseTwoFactorPayload(response.data);
      if (!parsed.code) {
        this.logger.warn(`[UserPool] 2FA URL 响应中未找到 6 位数字: ${parsed.searchableText.substring(0, 200)}`);
        return null;
      }

      if (this.isStaleCode(parsed, options)) {
        this.logger.warn(
          `[UserPool] 2FA 验证码不是本次挑战的新码, 继续等待: ` +
          `codeTime=${this.formatCodeTime(parsed.codeTimeMs)}, notBefore=${this.formatCodeTime(this.normalizeTimestamp(options.notBefore))}`,
        );
        return null;
      }

      this.logger.log(`[UserPool] 2FA 验证码获取成功: code=${this.maskCode(parsed.code)}, codeTime=${this.formatCodeTime(parsed.codeTimeMs)}`);
      return parsed.code;
    } catch (error: any) {
      this.logger.error(`[UserPool] 2FA URL 请求失败: ${error.message}`);
      return null;
    }
  }

  /**
   * @description 将 URL 中的敏感 query 值脱敏后用于日志.
   * @param url 原始 2FA URL
   * @returns 脱敏后的 URL; 解析失败时返回固定占位文本
   */
  private maskSensitiveUrl(url: string): string {
    try {
      const parsed = new URL(url);
      for (const key of parsed.searchParams.keys()) {
        parsed.searchParams.set(key, '***');
      }
      return parsed.toString();
    } catch {
      return '[invalid-2fa-url]';
    }
  }

  /**
   * @description 从常见 2FA 服务响应结构中提取验证码和时间戳.
   * @param payload HTTP 响应体
   * @returns 解析后的验证码元数据
   */
  private parseTwoFactorPayload(payload: unknown): ParsedTwoFactorPayload {
    const codeTimeText = this.extractNestedString(payload, ['data', 'code_time']);
    const nestedCode = this.extractNestedString(payload, ['data', 'code']);
    const searchableText = nestedCode || this.stringifyPayload(payload);
    const match = searchableText.match(/\b(\d{6})\b/);

    return {
      code: match?.[1] || null,
      codeTimeMs: this.parseProviderCodeTime(codeTimeText),
      searchableText,
    };
  }

  /**
   * @description 读取嵌套字符串字段.
   * @param payload 原始响应体
   * @param path 字段路径
   * @returns 字符串字段; 不存在时返回空字符串
   */
  private extractNestedString(payload: unknown, path: string[]): string {
    if (typeof payload === 'object' && payload !== null) {
      let current: any = payload;
      for (const key of path) {
        current = current?.[key];
      }
      return typeof current === 'string' ? current : '';
    }

    return '';
  }

  /**
   * @description 将响应体转换成用于日志和兜底匹配的字符串.
   * @param payload 原始响应体
   * @returns 字符串化后的响应体
   */
  private stringifyPayload(payload: unknown): string {
    if (typeof payload === 'string') return payload;

    try {
      return JSON.stringify(payload);
    } catch {
      return String(payload);
    }
  }

  /**
   * @description 判断验证码时间是否早于本次 Apple 2FA 挑战.
   * @param parsed 解析后的验证码元数据
   * @param options 拉码过滤选项
   * @returns true 表示应继续等待新验证码
   */
  private isStaleCode(parsed: ParsedTwoFactorPayload, options: FetchTwoFactorCodeOptions): boolean {
    const notBeforeMs = this.normalizeTimestamp(options.notBefore);
    if (!notBeforeMs || !parsed.codeTimeMs) return false;

    const skewMs = options.notBeforeSkewMs ?? 5000;
    return parsed.codeTimeMs + skewMs < notBeforeMs;
  }

  /**
   * @description 将 provider 返回的 code_time 解析为毫秒时间戳.
   *
   * 当前短信平台返回 `YYYY-MM-DD HH:mm:ss`, 实际语义是北京时间; 容器默认 UTC 时,
   * 不能直接交给 Date.parse, 否则会被误当成本地时区。
   *
   * @param value provider code_time 字段
   * @returns 毫秒时间戳; 无法解析时返回 null
   */
  private parseProviderCodeTime(value: string): number | null {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    if (match) {
      const [, year, month, day, hour, minute, second] = match.map(Number);
      return Date.UTC(year, month - 1, day, hour - 8, minute, second);
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * @description 标准化时间戳入参.
   * @param value Date 或毫秒时间戳
   * @returns 毫秒时间戳; 无效时返回 null
   */
  private normalizeTimestamp(value: Date | number | undefined): number | null {
    if (value instanceof Date) return value.getTime();
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /**
   * @description 格式化时间戳用于日志.
   * @param timestampMs 毫秒时间戳
   * @returns ISO 时间或 N/A
   */
  private formatCodeTime(timestampMs: number | null): string {
    return timestampMs ? new Date(timestampMs).toISOString() : 'N/A';
  }

  /**
   * @description 脱敏验证码用于诊断日志.
   * @param code 6 位验证码
   * @returns 只保留后两位的验证码
   */
  private maskCode(code: string): string {
    return `****${code.slice(-2)}`;
  }
}
