import { Injectable } from '@nestjs/common';

/**
 * @description Cookie 过期元数据.
 *
 * value 仍按 name=value 存储, 该结构只保留 Set-Cookie 中影响生命周期的属性,
 * 供 Redis session TTL 按接口实际返回时间动态计算。
 */
interface CookieExpiryMeta {
  /** Cookie 绝对过期时间戳 (ms); session cookie 没有该字段 */
  expiresAt?: number;
}

/**
 * @file cookie-jar.service.ts
 * @description Cookie 容器服务 — 替代 C++ HttpCookiesWrapper, 提供 Cookie 的
 * 合并 (Merge)、序列化 (ToRequestCookieString)、按名取值 (GetCookieValue)、
 * 清除空值 (RemoveEmptyCookies) 等能力.
 *
 * 设计意图: Apple Store 登录和查询上下文初始化流程需要在多步请求间手动管理 cookies,
 * 每一步请求返回的 Set-Cookie 都要合并到容器中供后续步骤使用.
 *
 * ★ 内存安全:
 * CookieContainer 实例是 per-task 作用域的 — 由初始化链路通过
 * CookieJarService.createContainer() 创建为局部变量, 任务结束后显式释放。
 * 每个容器通常只存储 10~30 个 cookie 键值对 (Apple Store 整个流程的 Set-Cookie 总量),
 * 单个请求的内存占用约 2~5KB, 即使 1000 并发也仅 ~5MB, 不会产生内存压力.
 *
 * 如果未来需要跨请求复用 cookies (如会话保持), 可迁移到 Redis 存储.
 * 当前场景只在初始化完成后序列化必要 cookie 到 Redis session 缓存。
 *
 * Reference: iTunesAPIs.cpp — HttpCookiesWrapper 类
 */

/**
 * @description 轻量级 Cookie 容器 — 模拟 C++ HttpCookiesWrapper 行为.
 *
 * 生命周期: 与单次查询请求绑定, 请求结束后自动 GC.
 * 不持有任何外部资源引用 (如 socket / file handle), 无需 finalize.
 *
 * 核心方法:
 * - merge(): 从 Set-Cookie 响应头合并 cookies
 * - toRequestString(): 生成请求用的 Cookie 头字符串
 * - getCookieValue(): 按名称获取单个 cookie 值
 * - isExist(): 检查某个 cookie 是否存在
 * - removeEmptyCookies(): 移除值为空的 cookies
 * - clear(): 清空所有 cookies
 * - destroy(): 显式销毁, 释放 Map 引用 (防御性措施)
 */
export class CookieContainer {
  /** 内部存储: cookieName → cookieValue */
  private cookies: Map<string, string> = new Map();
  /** Cookie 过期元数据: cookieName → expiresAt */
  private expiryMeta: Map<string, CookieExpiryMeta> = new Map();
  /** 是否已被销毁 — 防止销毁后继续使用 */
  private destroyed = false;

  /**
   * @description 从响应头的 Set-Cookie 数组中合并 cookies 到容器.
   * 同名 cookie 会被覆盖 (后者优先), 与 C++ HttpCookiesWrapper::Merge 行为一致.
   *
   * @param setCookieHeaders Set-Cookie 响应头数组 (axios 返回的 response.headers['set-cookie'])
   */
  mergeFromSetCookieHeaders(setCookieHeaders: string[] | undefined): void {
    if (this.destroyed || !setCookieHeaders || setCookieHeaders.length === 0) return;

    for (const header of setCookieHeaders) {
      this.mergeSingleSetCookieHeader(header);
    }
  }

  /**
   * @description 合并另一个 CookieContainer 的所有 cookies (Merge 语义).
   * @param other 另一个 CookieContainer 实例
   */
  mergeFrom(other: CookieContainer): void {
    if (this.destroyed) return;
    for (const [name, value] of other.cookies) {
      this.cookies.set(name, value);
    }
    for (const [name, meta] of other.expiryMeta) {
      this.expiryMeta.set(name, { ...meta });
    }
  }

  /**
   * @description 生成 HTTP 请求用的 Cookie 头字符串.
   * 格式: "name1=value1; name2=value2; ..."
   * @returns Cookie 头字符串
   */
  toRequestString(): string {
    if (this.destroyed) return '';
    this.pruneExpiredCookies();
    const parts: string[] = [];
    for (const [name, value] of this.cookies) {
      parts.push(`${name}=${value}`);
    }
    return parts.join('; ');
  }

  /**
   * @description 按名称获取单个 cookie 值.
   * @param name Cookie 名称
   * @returns Cookie 值, 不存在返回空字符串
   */
  getCookieValue(name: string): string {
    if (this.destroyed) return '';
    this.pruneExpiredCookies();
    return this.cookies.get(name) || '';
  }

  /**
   * @description 检查指定名称的 cookie 是否存在.
   * @param name Cookie 名称
   * @returns 存在返回 true
   */
  isExist(name: string): boolean {
    if (this.destroyed) return false;
    this.pruneExpiredCookies();
    return this.cookies.has(name);
  }

  /**
   * @description 获取容器内最早的 Cookie 过期时间.
   *
   * 仅统计 Set-Cookie 中带 Max-Age/Expires 的持久 Cookie; session cookie 没有
   * 明确过期时间, 不能作为 Redis TTL 的可靠依据。
   *
   * @param now 当前时间戳 (ms), 便于测试和调用方复用
   * @returns 最早过期时间戳; 没有明确过期 Cookie 时返回 null
   */
  getEarliestExpiresAt(now: number = Date.now()): number | null {
    if (this.destroyed) return null;
    this.pruneExpiredCookies(now);

    let earliest: number | null = null;
    for (const meta of this.expiryMeta.values()) {
      if (!meta.expiresAt || meta.expiresAt <= now) continue;
      if (earliest === null || meta.expiresAt < earliest) {
        earliest = meta.expiresAt;
      }
    }

    return earliest;
  }

  /**
   * @description 移除值为空字符串的 cookies — 防止空 cookie 干扰后续请求.
   * 与 C++ HttpCookiesWrapper::RemoveEmptyCookies 行为一致.
   */
  removeEmptyCookies(): void {
    if (this.destroyed) return;
    for (const [name, value] of this.cookies) {
      if (value === '' || value === undefined) {
        this.cookies.delete(name);
        this.expiryMeta.delete(name);
      }
    }
  }

  /**
   * @description 清空容器中的所有 cookies — 用于重置查询上下文.
   */
  clear(): void {
    if (this.destroyed) return;
    this.cookies.clear();
    this.expiryMeta.clear();
  }

  /**
   * @description 显式销毁容器 — 释放 Map 引用, 标记为已销毁.
   *
   * 防御性措施: 虽然 per-request 作用域下 GC 会自动回收,
   * 但在 executeQuery() 的 finally 块中调用 destroy() 可以:
   * 1. 让大 cookie 值 (如 myacinfo ~1KB) 尽早释放, 不等 GC 周期
   * 2. 防止异常路径下的意外引用导致延迟回收
   * 3. 通过 destroyed 标志阻止销毁后的误操作
   */
  destroy(): void {
    this.cookies.clear();
    this.expiryMeta.clear();
    this.destroyed = true;
  }

  /**
   * @description 获取当前容器中 cookie 数量 — 用于调试和监控.
   * @returns cookie 键值对数量
   */
  get size(): number {
    this.pruneExpiredCookies();
    return this.destroyed ? 0 : this.cookies.size;
  }

  /**
   * @description 合并单条 Set-Cookie 响应头.
   * @param header 单条 Set-Cookie 字符串
   * @sideEffects 更新 cookie 值和过期元数据; Max-Age<=0 时删除 cookie
   */
  private mergeSingleSetCookieHeader(header: string): void {
    const parts = header.split(';').map((part) => part.trim()).filter(Boolean);
    const nameValuePart = parts[0];
    if (!nameValuePart) return;

    const eqIndex = nameValuePart.indexOf('=');
    if (eqIndex === -1) return;

    const name = nameValuePart.substring(0, eqIndex).trim();
    const value = nameValuePart.substring(eqIndex + 1).trim();
    if (!name) return;

    const expiresAt = this.extractExpiresAt(parts.slice(1));
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.cookies.delete(name);
      this.expiryMeta.delete(name);
      return;
    }

    this.cookies.set(name, value);
    if (expiresAt !== undefined) {
      this.expiryMeta.set(name, { expiresAt });
    } else {
      this.expiryMeta.delete(name);
    }
  }

  /**
   * @description 从 Set-Cookie 属性中解析绝对过期时间.
   * @param attributes Set-Cookie 分号后的属性列表
   * @returns 绝对过期时间戳; 没有 Max-Age/Expires 时返回 undefined
   */
  private extractExpiresAt(attributes: string[]): number | undefined {
    let expiresAt: number | undefined;

    for (const attribute of attributes) {
      const eqIndex = attribute.indexOf('=');
      const rawName = eqIndex === -1 ? attribute : attribute.substring(0, eqIndex);
      const rawValue = eqIndex === -1 ? '' : attribute.substring(eqIndex + 1);
      const name = rawName.trim().toLowerCase();
      const value = rawValue.trim();

      if (name === 'max-age') {
        const maxAgeSeconds = Number.parseInt(value, 10);
        if (Number.isFinite(maxAgeSeconds)) {
          return Date.now() + maxAgeSeconds * 1000;
        }
      }

      if (name === 'expires') {
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp)) {
          expiresAt = timestamp;
        }
      }
    }

    return expiresAt;
  }

  /**
   * @description 清理已经过期的 Cookie.
   * @param now 当前时间戳 (ms)
   * @sideEffects 删除内存中已过期的 cookie 值和元数据
   */
  private pruneExpiredCookies(now: number = Date.now()): void {
    if (this.destroyed) return;

    for (const [name, meta] of this.expiryMeta) {
      if (meta.expiresAt !== undefined && meta.expiresAt <= now) {
        this.cookies.delete(name);
        this.expiryMeta.delete(name);
      }
    }
  }
}

/**
 * @description CookieContainer 工厂服务 — NestJS Injectable, 用于创建独立的 CookieContainer 实例.
 *
 * ★ 内存安全说明:
 * - CookieJarService 本身是 NestJS 默认的 singleton scope
 * - 但它创建的 CookieContainer 实例是调用者的局部变量, 生命周期由调用者控制
 * - 每次初始化任务会创建 1 个容器, 任务结束后释放本地引用
 * - 容器不会被 CookieJarService 持有引用, 无泄漏风险
 */
@Injectable()
export class CookieJarService {
  /**
   * @description 创建一个新的 CookieContainer 实例.
   * 调用者有责任在使用完毕后调用 destroy() (推荐) 或等待 GC 自动回收.
   * @returns 空的 CookieContainer
   */
  createContainer(): CookieContainer {
    return new CookieContainer();
  }
}
