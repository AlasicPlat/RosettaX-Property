/**
 * @file interface-response-log.util.ts
 * @description Apple 相关接口响应诊断日志工具.
 *
 * 该工具只输出排查 session/cookie 过期策略所需的响应结构、关键 header 和
 * Set-Cookie 属性, 不输出密码、token、cookie 原始值等敏感内容。
 */

/** 可参与诊断输出的响应对象最小结构 */
export interface InterfaceResponseLike {
  /** HTTP 状态码 */
  status?: number;
  /** 响应头集合 */
  headers?: Record<string, unknown>;
  /** 响应体 */
  data?: unknown;
}

/** 诊断日志的额外上下文 */
export interface InterfaceLogExtra {
  /** 请求方法 */
  method?: string;
  /** 请求 URL */
  url?: string;
  /** 当前请求前已携带的 cookie 数量 */
  requestCookieCount?: number;
  /** 当前响应后累计 cookie 数量 */
  accumulatedCookieCount?: number;
  /** 其他业务侧补充字段 */
  [key: string]: unknown;
}

/** Set-Cookie 头的脱敏摘要 */
interface CookieHeaderSummary {
  name: string;
  valueLength: number;
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: string;
  sameSite?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

/** 解析后响应体的脱敏摘要 */
interface ParsedPayloadSummary {
  type: string;
  length?: number;
  rootKeys?: string[];
  interestingFields?: Record<string, unknown>;
  containsSessionKeyword?: boolean;
  containsCookieKeyword?: boolean;
  containsExpireKeyword?: boolean;
  containsSignInKeyword?: boolean;
}

const MAX_INTERESTING_FIELDS = 80;
const MAX_ROOT_KEYS = 60;
const INTERESTING_FIELD_PATTERN =
  /(session|cookie|expire|expires|expiry|maxAge|max-age|ttl|token|auth|sign|login|logout|person|dsid|storefront|pod|error|failure|message|status|code|url|valid|invalid)/i;
const SENSITIVE_FIELD_PATTERN = /(password|passwd|secret|token|cookie|myacinfo|mz_at|mt-tkn|clear|authorization|auth)/i;
const URL_FIELD_PATTERN = /(url|uri|redirect|callback|location)/i;

/**
 * @description 构建一行可直接交给 Nest Logger 输出的接口诊断日志.
 * @param label 日志标签, 用于定位业务阶段和请求序号
 * @param response HTTP 响应对象
 * @param parsedPayload 已解析的响应体; 未传时使用 response.data 生成摘要
 * @param extra 额外上下文, 如请求 URL、cookie 数量等
 * @returns JSON 字符串格式的诊断日志
 */
export function buildInterfaceResponseLog(
  label: string,
  response: InterfaceResponseLike,
  parsedPayload?: unknown,
  extra: InterfaceLogExtra = {},
): string {
  const headers = normalizeHeaders(response.headers);
  const setCookieHeaders = toStringArray(headers['set-cookie']);
  const payload = parsedPayload === undefined ? response.data : parsedPayload;
  const snapshot = {
    label,
    status: response.status ?? null,
    request: summarizeExtra(extra),
    headers: summarizeHeaders(headers),
    setCookies: summarizeSetCookieHeaders(setCookieHeaders),
    body: summarizePayload(payload),
  };

  return `[InterfaceResponse] ${JSON.stringify(snapshot)}`;
}

/**
 * @description 将账号标识脱敏为日志可读格式.
 * @param value 原始账号标识或邮箱
 * @returns 脱敏后的账号标识
 */
export function maskLogIdentifier(value: string): string {
  const trimmed = value.trim();
  const atIndex = trimmed.indexOf('@');
  if (atIndex > 0) {
    const localPart = trimmed.substring(0, atIndex);
    const domain = trimmed.substring(atIndex + 1);
    return `${maskText(localPart, 2, 1)}@${domain}`;
  }
  return maskText(trimmed, 6, 4);
}

/**
 * @description 规范化响应头 key, 便于大小写无关地读取 header.
 * @param headers 原始响应头
 * @returns 小写 header key 到原始值的映射
 */
function normalizeHeaders(headers?: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!headers) return result;

  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }

  return result;
}

/**
 * @description 摘要化请求上下文字段, URL 会去掉敏感 query 参数值.
 * @param extra 额外上下文
 * @returns 可安全输出的上下文
 */
function summarizeExtra(extra: InterfaceLogExtra): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined || value === null || value === '') continue;
    result[key] = URL_FIELD_PATTERN.test(key) && typeof value === 'string'
      ? sanitizeUrl(value)
      : sanitizeLogValue(key, value);
  }
  return result;
}

/**
 * @description 摘要化关键响应头, 仅保留与接口路由、认证和缓存过期相关的字段.
 * @param headers 小写化后的响应头
 * @returns 关键响应头摘要
 */
function summarizeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === 'set-cookie') continue;
    if (!isInterestingHeader(key)) continue;
    result[key] = URL_FIELD_PATTERN.test(key) && typeof value === 'string'
      ? sanitizeUrl(value)
      : sanitizeLogValue(key, value);
  }
  return result;
}

/**
 * @description 判断响应头是否值得输出到接口诊断日志.
 * @param headerName 小写响应头名
 * @returns true 表示该 header 与 session/cookie/路由排查有关
 */
function isInterestingHeader(headerName: string): boolean {
  return (
    headerName === 'location' ||
    headerName === 'content-type' ||
    headerName === 'content-length' ||
    headerName === 'cache-control' ||
    headerName === 'pragma' ||
    headerName === 'expires' ||
    headerName === 'date' ||
    headerName === 'retry-after' ||
    headerName === 'www-authenticate' ||
    headerName === 'pod' ||
    headerName.startsWith('x-apple') ||
    headerName.startsWith('x-set-apple')
  );
}

/**
 * @description 解析 Set-Cookie 响应头, 输出 cookie 名、值长度和过期属性.
 * @param setCookieHeaders Set-Cookie 响应头数组
 * @returns Set-Cookie 脱敏摘要数组
 */
function summarizeSetCookieHeaders(setCookieHeaders: string[]): CookieHeaderSummary[] {
  return setCookieHeaders.map((header) => {
    const parts = header.split(';').map((part) => part.trim()).filter(Boolean);
    const [nameValue = ''] = parts;
    const eqIndex = nameValue.indexOf('=');
    const name = eqIndex >= 0 ? nameValue.substring(0, eqIndex).trim() : nameValue.trim();
    const value = eqIndex >= 0 ? nameValue.substring(eqIndex + 1).trim() : '';
    const summary: CookieHeaderSummary = { name, valueLength: value.length };

    for (const attr of parts.slice(1)) {
      const attrEqIndex = attr.indexOf('=');
      const attrName = (attrEqIndex >= 0 ? attr.substring(0, attrEqIndex) : attr).trim().toLowerCase();
      const attrValue = attrEqIndex >= 0 ? attr.substring(attrEqIndex + 1).trim() : '';
      if (attrName === 'domain') summary.domain = attrValue;
      if (attrName === 'path') summary.path = attrValue;
      if (attrName === 'expires') summary.expires = attrValue;
      if (attrName === 'max-age') summary.maxAge = attrValue;
      if (attrName === 'samesite') summary.sameSite = attrValue;
      if (attrName === 'httponly') summary.httpOnly = true;
      if (attrName === 'secure') summary.secure = true;
    }

    return summary;
  });
}

/**
 * @description 生成响应体摘要, 对对象递归提取 session/cookie/expire 等可疑字段.
 * @param payload 响应体或已解析对象
 * @returns 响应体脱敏摘要
 */
function summarizePayload(payload: unknown): ParsedPayloadSummary {
  if (payload === undefined || payload === null) {
    return { type: String(payload) };
  }

  if (typeof payload === 'string') {
    return summarizeStringPayload(payload);
  }

  if (Array.isArray(payload)) {
    return {
      type: 'array',
      length: payload.length,
      interestingFields: collectInterestingFields(payload),
    };
  }

  if (typeof payload === 'object') {
    const objectPayload = payload as Record<string, unknown>;
    return {
      type: 'object',
      rootKeys: Object.keys(objectPayload).slice(0, MAX_ROOT_KEYS),
      interestingFields: collectInterestingFields(objectPayload),
    };
  }

  return {
    type: typeof payload,
    interestingFields: { value: sanitizeLogValue('value', payload) },
  };
}

/**
 * @description 摘要化字符串响应体, 只输出长度和关键词命中情况.
 * @param payload 字符串响应体
 * @returns 字符串响应体摘要
 */
function summarizeStringPayload(payload: string): ParsedPayloadSummary {
  return {
    type: 'string',
    length: payload.length,
    containsSessionKeyword: /session/i.test(payload),
    containsCookieKeyword: /cookie/i.test(payload),
    containsExpireKeyword: /expire|expired|expiry|expires/i.test(payload),
    containsSignInKeyword: /sign\s*in|signin|登录/i.test(payload),
  };
}

/**
 * @description 递归提取疑似会话、cookie、过期和登录态字段.
 * @param payload 已解析的对象或数组
 * @returns 字段路径到脱敏值的映射
 */
function collectInterestingFields(payload: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const seen = new WeakSet<object>();

  /**
   * @description 深度遍历对象, 限制字段数量和递归层级以避免日志过大.
   * @param value 当前节点值
   * @param path 当前字段路径
   * @param depth 当前递归深度
   */
  function visit(value: unknown, path: string, depth: number): void {
    if (Object.keys(result).length >= MAX_INTERESTING_FIELDS || depth > 5) return;
    if (value === null || value === undefined) return;

    if (typeof value !== 'object') {
      if (INTERESTING_FIELD_PATTERN.test(path)) {
        result[path] = sanitizeLogValue(path, value);
      }
      return;
    }

    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) return;
    seen.add(objectValue);

    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }

    for (const [key, child] of Object.entries(objectValue)) {
      const nextPath = path ? `${path}.${key}` : key;
      if (INTERESTING_FIELD_PATTERN.test(nextPath) && (child === null || typeof child !== 'object')) {
        result[nextPath] = sanitizeLogValue(nextPath, child);
      }
      visit(child, nextPath, depth + 1);
    }
  }

  visit(payload, '', 0);
  return result;
}

/**
 * @description 将未知类型转换为字符串数组.
 * @param value 原始 header 值
 * @returns 字符串数组
 */
function toStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  return [String(value)];
}

/**
 * @description 对日志值进行脱敏和长度控制.
 * @param key 字段路径或 header 名
 * @param value 原始值
 * @returns 可安全输出的值
 */
function sanitizeLogValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (URL_FIELD_PATTERN.test(key)) {
      return sanitizeUrl(value);
    }
    if (SENSITIVE_FIELD_PATTERN.test(key)) {
      return maskTextWithLength(value);
    }
    if (value.length > 180) {
      return `${value.substring(0, 80)}...[truncated len=${value.length}]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(key, item));
  }

  if (value && typeof value === 'object') {
    return '[object]';
  }

  return value;
}

/**
 * @description URL 脱敏, 保留 origin/path 和 query 参数名, 隐藏参数值.
 * @param value 原始 URL 字符串
 * @returns 脱敏后的 URL 字符串
 */
function sanitizeUrl(value: string): string {
  try {
    const parsedUrl = new URL(value);
    const queryKeys = Array.from(parsedUrl.searchParams.keys());
    const querySuffix = queryKeys.length > 0 ? `?${queryKeys.join('&')}=[masked]` : '';
    return `${parsedUrl.origin}${parsedUrl.pathname}${querySuffix}`;
  } catch {
    if (value.length > 180) {
      return `${value.substring(0, 80)}...[truncated len=${value.length}]`;
    }
    return value;
  }
}

/**
 * @description 按长度输出脱敏文本, 仅保留首尾少量字符.
 * @param value 原始文本
 * @returns 带长度信息的脱敏文本
 */
function maskTextWithLength(value: string): string {
  return `${maskText(value, 4, 4)}(len=${value.length})`;
}

/**
 * @description 脱敏任意文本.
 * @param value 原始文本
 * @param prefixLength 保留前缀长度
 * @param suffixLength 保留后缀长度
 * @returns 脱敏文本
 */
function maskText(value: string, prefixLength: number, suffixLength: number): string {
  if (value.length <= prefixLength + suffixLength) {
    return '*'.repeat(Math.max(value.length, 1));
  }
  return `${value.substring(0, prefixLength)}***${value.substring(value.length - suffixLength)}`;
}
