import { Injectable, Logger } from '@nestjs/common';
import { HttpProxyService } from '../http-proxy';
import { ProxyConfig } from '../proxy/proxy-config.interface';
import { SessionAccountData } from './interfaces/managed-session.interface';
import * as plist from 'plist';
import {
  buildInterfaceResponseLog,
  maskLogIdentifier,
} from '../../utils/interface-response-log.util';

/**
 * @file itunes-client.service.ts
 * @description iTunes 协议翻译层 — 1:1 翻译 Java AppleStoreClient 中的所有 iTunes API 调用.
 *
 * 本服务为 **无状态服务**: 所有方法接收会话数据 (account / cookies / proxy) 作为参数,
 * 不持有任何运行时会话状态。会话管理由 SessionManagerService 负责。
 *
 * 完整 API 覆盖:
 * 1. fetchBag() — 获取 bag.xml 动态 endpoint
 * 2. login() — MZFinance plist 登录 (含 2FA / 多次重试)
 * 3. redeemInfo() — 验证礼品卡 (GET commerce/redeemInfo)
 * 4. redeemCode() — 兑换礼品卡 (POST commerce/redeemCodeSrv)
 * 5. fetchBalance() — 双链路余额查询 (accountSummary + addFunds/info)
 *
 * Reference: @docs AppleStoreClient.java (完整协议实现)
 * Reference: @docs ipatool (github.com/majd/ipatool) — MZFinance 认证参照
 */

// ── 常量 — 对标 Java AppleStoreClient 静态常量 ──
const BAG_URL = 'https://init.itunes.apple.com/bag.xml?ix=6&os=14&locale=zh_CN';
const DEFAULT_AUTH_URL = 'https://auth.itunes.apple.com/auth/v1/native';
const DEFAULT_ACCOUNT_SUMMARY_URL = 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/accountSummary';
/** Anisette 服务地址 — 通过外部服务获取设备认证 headers */
const ANISETTE_URL = process.env.ANISETTE_URL || 'http://localhost:6969';

/**
 * @description 登录 API 返回的原始数据 — 供 SessionManagerService 构建 ManagedSession 使用
 */
export interface LoginRawResult {
  success: boolean;
  needs2FA: boolean;
  errorMessage?: string;
  account?: SessionAccountData;
  /** login 响应中捕获的 session cookies (mz_at_ssl / mt-tkn / mz_at0 等) */
  sessionCookies: Map<string, string>;
}

@Injectable()
export class ItunesClientService {
  private readonly logger = new Logger(ItunesClientService.name);

  // 缓存的 bag.xml 动态 endpoint — 首次调用 fetchBag() 后填充
  private authUrl: string | null = null;
  private accountSummaryUrl: string | null = null;

  constructor(private readonly httpProxyService: HttpProxyService) { }

  // ==================== Phase 0: Bag ====================

  /**
   * @description 获取 bag.xml 中的动态 endpoint — 参照 ipatool.
   *
   * bag.xml 是 Apple 的服务发现机制, 返回 XML plist 包含所有 API endpoint.
   * 只在首次调用时请求, 后续复用缓存. 因为 endpoint 全局共享, 不依赖会话.
   *
   * Reference: AppleStoreClient.java L187-265 (fetchBag + parseBag)
   */
  async fetchBag(): Promise<void> {
    if (this.authUrl) return; // 已缓存

    // this.logger.log(`>>> 获取 Bag: ${BAG_URL}`);

    try {
      const response = await this.httpProxyService.request({
        method: 'GET',
        url: BAG_URL,
        headers: { Accept: 'application/xml' },
        useProxy: false, // bag.xml 不需要代理
      });

      if (response.status !== 200) {
        throw new Error(`Bag 请求失败: HTTP ${response.status}`);
      }

      const body = typeof response.data === 'string' ? response.data : String(response.data);
      this.parseBag(body);
      // this.logger.log(`  ✓ authUrl = ${this.authUrl}`);
      // this.logger.log(`  ✓ accountSummaryUrl = ${this.accountSummaryUrl}`);
    } catch (error: any) {
      this.logger.warn(`Bag 获取失败, 使用默认 URL: ${error.message}`);
      this.authUrl = DEFAULT_AUTH_URL;
      this.accountSummaryUrl = DEFAULT_ACCOUNT_SUMMARY_URL;
    }
  }

  /**
   * @description 解析 bag.xml 响应, 提取 authenticateAccount 和 accountSummary 的 URL.
   *
   * bag.xml 格式: XML plist 嵌套在 <Document><Protocol> 标签内,
   * 所有 URL 存在 plist dict 的 string 值中.
   *
   * Reference: AppleStoreClient.java L215-265
   *
   * @param xmlBody bag.xml 响应体
   */
  private parseBag(xmlBody: string): void {
    try {
      // 提取 <plist>...</plist> 部分
      const plistStart = xmlBody.indexOf('<plist');
      const plistEnd = xmlBody.indexOf('</plist>') + '</plist>'.length;

      if (plistStart < 0 || plistEnd <= 0) {
        this.logger.warn('Bag 中未找到 plist 数据, 使用默认 URL');
        this.authUrl = DEFAULT_AUTH_URL;
        this.accountSummaryUrl = DEFAULT_ACCOUNT_SUMMARY_URL;
        return;
      }

      const plistXml = xmlBody.substring(plistStart, plistEnd);
      const parsed = plist.parse(plistXml) as Record<string, any>;

      // 递归收集所有 URL
      const allUrls = new Map<string, string>();
      this.collectUrls(parsed, '', allUrls);

      // urlBag 子字典
      if (parsed.urlBag && typeof parsed.urlBag === 'object') {
        this.collectUrls(parsed.urlBag, 'urlBag.', allUrls);
      }

      // 查找目标 endpoint
      this.authUrl = this.findUrl(allUrls, 'authenticateAccount', 'authenticate') || DEFAULT_AUTH_URL;
      this.accountSummaryUrl = this.findUrl(allUrls, 'accountSummary') || DEFAULT_ACCOUNT_SUMMARY_URL;
    } catch (error: any) {
      this.logger.warn(`Bag 解析异常, 使用默认 URL: ${error.message}`);
      this.authUrl = DEFAULT_AUTH_URL;
      this.accountSummaryUrl = DEFAULT_ACCOUNT_SUMMARY_URL;
    }
  }

  /** 递归收集字典中所有 string 类型的 URL */
  private collectUrls(dict: Record<string, any>, prefix: string, out: Map<string, string>): void {
    for (const [key, val] of Object.entries(dict)) {
      if (typeof val === 'string' && val.startsWith('http')) {
        out.set(prefix + key, val);
      }
    }
  }

  /** 从收集的 URL 中查找匹配的 key */
  private findUrl(urls: Map<string, string>, ...candidates: string[]): string | null {
    for (const candidate of candidates) {
      for (const [key, val] of urls) {
        if (key.toLowerCase().includes(candidate.toLowerCase())) {
          return val;
        }
      }
    }
    return null;
  }

  // ==================== Phase 1: 登录 ====================

  /**
   * @description Apple ID MZFinance 登录 — 对标 Java AppleStoreClient.login().
   *
   * 协议流程 (参照 ipatool):
   * 1. 构造 XML plist 请求体 (appleId, password, guid, attempt, why)
   * 2. POST 到 authenticateAccount endpoint
   * 3. 最多 4 次重试 (第 1 次 -5000 failureType 是正常的)
   * 4. 解析响应 plist → 提取 passwordToken / dsPersonId / storeFront / pod
   * 5. 捕获 Set-Cookie (mz_at_ssl / mt-tkn / mz_at0 等关键 session cookies)
   *
   * Reference: AppleStoreClient.java L311-482
   *
   * @param email Apple ID 邮箱
   * @param password 密码 (含 2FA 时密码+验证码拼接, 如 "mypassword123456")
   * @param guid 设备指纹 GUID
   * @param proxy 代理实例 (null 表示直连)
   * @returns LoginRawResult
   */
  async login(
    email: string,
    password: string,
    guid: string,
    proxy: ProxyConfig | null,
  ): Promise<LoginRawResult> {
    await this.fetchBag();

    // this.logger.log(`>>> 登录 Apple ID: ${email}`);
    // this.logger.log(`  Auth URL: ${this.authUrl}`);

    let currentUrl = this.authUrl!;
    const sessionCookies = new Map<string, string>();

    // ipatool 重试逻辑: 最多 4 次尝试
    for (let attempt = 1; attempt <= 4; attempt++) {
      // this.logger.log(`  尝试 #${attempt}: POST ${currentUrl}`);

      // 构造 XML plist 请求体 — 对标 Java NSDictionary → toXMLPropertyList()
      const payload: Record<string, string> = {
        appleId: email,
        attempt: String(attempt),
        guid,
        password,
        rmp: '0',
        why: 'signIn',
      };
      const plistBody = plist.build(payload);

      let response: any;
      try {
        response = await this.httpProxyService.requestWithProxy(
          {
            method: 'POST',
            url: currentUrl,
            data: plistBody,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent':
                'Configurator/2.15 (Macintosh; OperatingSystem X 11.0.0; 16G29) AppleWebKit/2603.3.8',
            },
            maxRedirects: 0,
            validateStatus: () => true,
          },
          proxy,
        );
      } catch (error: any) {
        this.logger.error(`  登录请求失败: ${error.message}`);
        return { success: false, needs2FA: false, errorMessage: `网络请求失败: ${error.message}`, sessionCookies };
      }

      const body = typeof response.data === 'string' ? response.data : String(response.data);
      // this.logger.log(`  响应: HTTP ${response.status} (body ${body.length} bytes)`);

      // 捕获 Set-Cookie — 登录响应包含 mz_at_ssl / mt-tkn / mz_at0 等关键 cookie
      this.captureSetCookies(response.headers?.['set-cookie'], sessionCookies);

      // 302 重定向 — 对标 Java L375-382
      if (response.status === 302) {
        this.logger.log(buildInterfaceResponseLog(
          'itunes.login.redirect',
          response,
          undefined,
          {
            method: 'POST',
            url: currentUrl,
            attempt,
            account: maskLogIdentifier(email),
            sessionCookieCount: sessionCookies.size,
          },
        ));
        const location = response.headers?.location;
        if (location) {
          this.logger.log(`  302 重定向 → ${location}`);
          currentUrl = location;
          continue;
        }
      }

      // 解析响应 plist — 对标 Java L365-407
      let result: Record<string, any> | null = null;
      if (body && body.trim().length > 0) {
        try {
          result = plist.parse(body) as Record<string, any>;
        } catch {
          this.logger.warn('  响应 plist 解析失败');
        }
      }

      this.logger.log(buildInterfaceResponseLog(
        'itunes.login.response',
        response,
        result ?? undefined,
        {
          method: 'POST',
          url: currentUrl,
          attempt,
          account: maskLogIdentifier(email),
          sessionCookieCount: sessionCookies.size,
        },
      ));

      if (result) {
        const failureType = result.failureType as string | undefined;
        const customerMessage = result.customerMessage as string | undefined;

        // 第一次 -5000 是正常的, 重试 — 对标 Java L389-393
        if (attempt === 1 && failureType === '-5000') {
          this.logger.log('  -5000 (expected on first attempt), retrying...');
          continue;
        }

        // 需要 2FA — 对标 Java L395-398
        if (
          customerMessage === 'MZFinance.BadLogin.Configurator_message' &&
          (!failureType || failureType === '')
        ) {
          return { success: false, needs2FA: true, errorMessage: '需要 2FA 验证码', sessionCookies };
        }

        // 账号被禁用 — 对标 Java L400-402
        if (customerMessage === 'Your account is disabled.') {
          return {
            success: false,
            needs2FA: false,
            errorMessage: `Apple 账号已被禁用: ${customerMessage}`,
            sessionCookies,
          };
        }

        // 其他登录失败 — 对标 Java L404-407
        if (failureType && failureType !== '') {
          return {
            success: false,
            needs2FA: false,
            errorMessage: `登录失败: ${failureType} - ${customerMessage || '未知错误'}`,
            sessionCookies,
          };
        }
      }

      // 登录成功 — 对标 Java L411-472
      if (response.status === 200 && result) {
        // 再次捕获 cookies (确保不遗漏)
        this.captureSetCookies(response.headers?.['set-cookie'], sessionCookies);

        const passwordToken = result.passwordToken as string | undefined;
        const dsPersonId = result.dsPersonId as string | undefined;

        if (passwordToken && dsPersonId) {
          // 提取 headers — 对标 Java L426-427
          const storeFront = response.headers?.['x-set-apple-store-front'] || '';
          const pod = response.headers?.pod || '';

          // 提取账户名 — 对标 Java L430-440
          let name = '';
          if (result.accountInfo?.address) {
            const first = result.accountInfo.address.firstName || '';
            const last = result.accountInfo.address.lastName || '';
            name = `${first} ${last}`.trim();
          }

          // 提取余额信息 — 对标 Java L451-470
          const creditDisplay = (result.creditDisplay as string) || null;
          const creditBalance = (result.creditBalance as string) || null;
          const freeSongBalance = (result.freeSongBalance as string) || null;
          const clearToken = (result.clearToken as string) || null;

          const account: SessionAccountData = {
            email,
            name,
            passwordToken,
            directoryServicesId: dsPersonId,
            storeFront,
            pod,
            clearToken,
            creditBalance: creditDisplay || creditBalance || null,
            creditDisplay: creditDisplay || null,
            freeSongBalance,
          };

          // this.logger.log(`  ✓ 登录成功!`);
          // this.logger.log(`    Name: ${name}, DSID: ${dsPersonId}, StoreFront: ${storeFront}, Pod: ${pod}`);
          // this.logger.log(`    Token (前20): ${passwordToken.substring(0, Math.min(20, passwordToken.length))}...`);
          // this.logger.log(`    creditDisplay: ${creditDisplay}, creditBalance: ${creditBalance}`);
          // this.logger.log(`    sessionCookies 数量: ${sessionCookies.size}`);
          // 完整原始响应 — 用于排查可用字段
          // this.logger.debug(`    [RAW LOGIN RESPONSE] ${JSON.stringify(result, null, 2)}`);

          return { success: true, needs2FA: false, account, sessionCookies };
        }
      }
    }

    return { success: false, needs2FA: false, errorMessage: '登录失败: 超过最大重试次数 (4次)', sessionCookies };
  }

  // ==================== Phase 2: 余额查询 (双链路 fallback) ====================

  /**
   * @description 获取账户余额 — 双链路策略, 对标 Java AppleStoreClient.fetchBalance().
   *
   * 链路 A (主要): accountSummary — 用 X-Token header 认证, 响应为 plist, 含 creditDisplay.
   * 链路 B (备选): addFunds/info — 用 X-Token header 认证, 响应为 JSON, 含 current-balance.
   *
   * Reference: AppleStoreClient.java L533-555
   *
   * @param account 账号数据
   * @param sessionCookies session cookies
   * @param guid 设备指纹
   * @param proxy 代理实例 (null 直连)
   * @returns 格式化的余额字符串 (如 "¥0.00"), 失败返回 null
   */
  async fetchBalance(
    account: SessionAccountData,
    sessionCookies: Map<string, string>,
    guid: string,
    proxy: ProxyConfig | null,
  ): Promise<string | null> {
    if (!account.passwordToken || !account.directoryServicesId) {
      this.logger.warn('  ⚠ fetchBalance: 未登录');
      return null;
    }

    // 链路 A: accountSummary
    const balanceFromSummary = await this.fetchBalanceViaAccountSummary(account, sessionCookies, guid, proxy);
    if (balanceFromSummary) {
      this.logger.log(`  ✓ 余额已通过 accountSummary 获取: ${balanceFromSummary}`);
      return balanceFromSummary;
    }

    // 链路 B: addFunds/info
    this.logger.log('  accountSummary 失败, 尝试 addFunds/info (X-Token)...');
    const balanceFromAddFunds = await this.fetchBalanceViaAddFunds(account, sessionCookies, guid, proxy);
    if (balanceFromAddFunds) {
      return balanceFromAddFunds;
    }

    this.logger.warn('  ✘ 两条链路均未获取到余额');
    return null;
  }

  /**
   * @description 链路 A: 通过 accountSummary 获取余额 — 对标 Java fetchBalanceViaAccountSummary().
   *
   * 使用 X-Token header 认证 (passwordToken), 不需要 iOS session cookies.
   * Apple 在响应中同时返回 plist body (含 creditDisplay) 和 Set-Cookie (真实 session cookies).
   *
   * Reference: AppleStoreClient.java L562-693
   */
  private async fetchBalanceViaAccountSummary(
    account: SessionAccountData,
    sessionCookies: Map<string, string>,
    guid: string,
    proxy: ProxyConfig | null,
  ): Promise<string | null> {
    try {
      const dsid = account.directoryServicesId;
      const token = account.passwordToken;
      const pod = account.pod;
      const host = pod ? `p${pod}-buy.itunes.apple.com` : 'buy.itunes.apple.com';
      const url = `https://${host}/WebObjects/MZFinance.woa/wa/accountSummary?guid=${guid}`;

      this.logger.log(`>>> 查询余额 (accountSummary): ${url}`);

      const anisetteHeaders = await this.getAnisetteHeaders();
      const storeFront = account.storeFront || '143465-19,29';

      const headers: Record<string, string> = {
        Connection: 'keep-alive',
        'X-Apple-Store-Front': storeFront,
        'X-Apple-Partner': 'origin.0',
        'X-Apple-Client-Application': 'Software',
        'X-Apple-Connection-Type': 'WiFi',
        'X-Apple-Client-Versions': 'GameCenter/2.0',
        'X-Token-T': 'M',
        'X-Apple-Tz': '28800',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0',
        Accept: '*/*',
        'Content-Type': 'application/x-apple-plist; Charset=UTF-8',
        'User-Agent': 'iTunes/12.12 (Macintosh; OS X 10.10) AppleWebKit/600.1.3.41',
        'X-Apple-Software-Guid': guid,
        'X-Token': token,
        'X-Dsid': dsid,
        'iCloud-DSID': dsid,
        Referer: `https://${host}/WebObjects/MZFinance.woa/wa/accountSummary`,
        ...anisetteHeaders,
      };

      const response = await this.httpProxyService.requestWithProxy(
        { method: 'GET', url, headers, validateStatus: () => true },
        proxy,
      );

      const body = typeof response.data === 'string' ? response.data : String(response.data);
      this.logger.log(`  accountSummary 响应: HTTP ${response.status} (${body.length} bytes)`);

      // 捕获 Set-Cookie — 获取真实 session cookies
      this.captureSetCookies(response.headers?.['set-cookie'], sessionCookies);

      if (response.status !== 200) {
        this.logger.warn(`  ✘ accountSummary HTTP ${response.status}`);
        return null;
      }

      return this.parseBalanceFromAccountSummary(body, account);
    } catch (error: any) {
      this.logger.error(`  ✘ accountSummary 异常: ${error.message}`);
      return null;
    }
  }

  /**
   * @description 从 accountSummary 响应体中解析余额 — plist + regex 双策略.
   *
   * Reference: AppleStoreClient.java L635-693
   */
  private parseBalanceFromAccountSummary(body: string, account: SessionAccountData): string | null {
    // 策略 1: 解析 plist
    try {
      const parsed = plist.parse(body) as Record<string, any>;
      const creditDisplay = parsed.creditDisplay as string | undefined;
      if (creditDisplay) {
        this.logger.log(`  ✓ accountSummary plist 余额 (creditDisplay): ${creditDisplay}`);
        account.creditDisplay = creditDisplay;
        account.creditBalance = creditDisplay;
        return creditDisplay;
      }
      const creditBalance = parsed.creditBalance as string | undefined;
      if (creditBalance) {
        this.logger.log(`  ✓ accountSummary plist 余额 (creditBalance): ${creditBalance}`);
        account.creditBalance = creditBalance;
        if (!account.creditDisplay) account.creditDisplay = creditBalance;
        return creditBalance;
      }
    } catch {
      this.logger.log('  plist 解析失败, 尝试文本匹配...');
    }

    // 策略 2: 正则匹配 — 对标 Java L669-688
    const patterns = [
      /creditDisplay["']?\s*[:=]\s*["']([^"']+)["']/,
      /¥[\d,]+\.\d{2}/,
      /\$[\d,]+\.\d{2}/,
      /current.?balance["']?\s*[:=]\s*["']([^"']+)["']/i,
    ];
    for (const p of patterns) {
      const m = body.match(p);
      if (m) {
        const balance = m[1] || m[0];
        this.logger.log(`  ✓ accountSummary 文本匹配余额: ${balance}`);
        account.creditDisplay = balance;
        account.creditBalance = balance;
        return balance;
      }
    }

    this.logger.warn(`  ✘ accountSummary 无法解析余额`);
    return null;
  }

  /**
   * @description 链路 B: 通过 addFunds/info 获取余额 — 对标 Java fetchBalanceViaAddFunds().
   *
   * Reference: AppleStoreClient.java L699-783
   */
  private async fetchBalanceViaAddFunds(
    account: SessionAccountData,
    sessionCookies: Map<string, string>,
    guid: string,
    proxy: ProxyConfig | null,
  ): Promise<string | null> {
    try {
      const pod = account.pod;
      const host = pod ? `p${pod}-buy.itunes.apple.com` : 'buy.itunes.apple.com';
      const url = `https://${host}/commerce/addFunds/info?guid=${guid}&guid=${guid}`;

      this.logger.log(`>>> 查询余额 (addFunds/info): ${url}`);

      const anisetteHeaders = await this.getAnisetteHeaders();
      const dsid = account.directoryServicesId;
      const token = account.passwordToken;
      const storeFront = account.storeFront || '143465-19,29';
      const clientTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

      const headers: Record<string, string> = {
        Connection: 'keep-alive',
        'X-Apple-Store-Front': storeFront,
        'X-Apple-Partner': 'origin.0',
        'X-Apple-Client-Application': 'Software',
        'X-Apple-Connection-Type': 'WiFi',
        'X-Apple-Client-Versions': 'GameCenter/2.0',
        'X-Token-T': 'M',
        'X-Apple-Tz': '28800',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0',
        Accept: '*/*',
        'Content-Type': 'application/x-apple-plist; Charset=UTF-8',
        'User-Agent': 'iTunes/12.12 (Macintosh; OS X 10.10) AppleWebKit/600.1.3.41',
        'X-Apple-Software-Guid': guid,
        'X-Token': token,
        'X-Dsid': dsid,
        'iCloud-DSID': dsid,
        'X-Apple-I-Client-Time': clientTime,
        Referer: `https://${host}/commerce/addFunds/info`,
        ...anisetteHeaders,
      };

      const response = await this.httpProxyService.requestWithProxy(
        { method: 'GET', url, headers, validateStatus: () => true },
        proxy,
      );

      const body = typeof response.data === 'string' ? response.data : String(response.data);
      this.logger.log(`  addFunds/info 响应: HTTP ${response.status} (${body.length} bytes)`);

      this.captureSetCookies(response.headers?.['set-cookie'], sessionCookies);

      if (response.status !== 200) {
        this.logger.warn(`  ✘ addFunds/info HTTP ${response.status}`);
        return null;
      }

      // 解析 JSON — 对标 Java L758-777
      const json = JSON.parse(body);
      const status = json.status ?? -1;
      if (status !== 0) {
        this.logger.warn(`  ✘ addFunds/info status=${status}`);
        return null;
      }

      const currentBalance = json.data?.attributes?.info?.['current-balance'] ?? null;
      if (currentBalance) {
        this.logger.log(`  ✓ addFunds/info 余额: ${currentBalance}`);
        account.creditDisplay = currentBalance;
        account.creditBalance = currentBalance;
      }
      return currentBalance;
    } catch (error: any) {
      this.logger.error(`  ✘ addFunds/info 异常: ${error.message}`);
      return null;
    }
  }

  // ==================== Session Cookie 建立 ====================

  /**
   * @description 确保 sessionCookies 中包含真实的 mz_at_ssl session cookie — 对标 Java ensureSessionCookies().
   *
   * commerce 端点 (redeemInfo / redeemCode) 需要的是 mz_at_ssl 真实 session cookie (~48 bytes, "AwUA" 开头),
   * 而非 login 返回的 passwordToken (~200+ chars). 如果当前 mz_at_ssl 缺失或仍为 passwordToken,
   * 则先通过 accountSummary (X-Token 认证) 建立真实 session cookies.
   *
   * Java 流程:
   *   1. login → Set-Cookie 中 mz_at_ssl 值 = passwordToken (不是真实 session cookie)
   *   2. ensureSessionCookies() → 检测到 mz_at_ssl == passwordToken
   *   3. fetchBalance() → accountSummary (X-Token) → Set-Cookie 返回真实 mz_at_ssl (~48 bytes)
   *   4. redeemInfo (Cookie 认证) → 使用真实 mz_at_ssl → ✓ 200
   *
   * Reference: AppleStoreClient.java L507-514 (ensureSessionCookies), L822-883 (establishSessionCookies)
   *
   * @param account 已登录的账号数据
   * @param sessionCookies 当前 session cookies (会被就地更新)
   * @param guid 设备指纹
   * @param proxy 代理实例
   */
  async ensureSessionCookies(
    account: SessionAccountData,
    sessionCookies: Map<string, string>,
    guid: string,
    proxy: ProxyConfig | null,
  ): Promise<void> {
    const dsid = account.directoryServicesId;
    const passwordToken = account.passwordToken;

    // 查找 mz_at_ssl 相关 cookie — 可能带 dsid 后缀 (mz_at_ssl-{dsid}) 或不带
    let mzAtSslKey: string | null = null;
    let mzAtSslValue: string | null = null;
    for (const [key, value] of sessionCookies) {
      if (key === 'mz_at_ssl' || key === `mz_at_ssl-${dsid}` || key.startsWith('mz_at_ssl')) {
        mzAtSslKey = key;
        mzAtSslValue = value;
        break;
      }
    }

    // 判断是否需要建立真实 session cookies:
    // 1. mz_at_ssl 完全缺失
    // 2. mz_at_ssl 的值等于 passwordToken (login 返回的不是真实 session cookie)
    // 3. mz_at_ssl 长度 > 100 (真实 session cookie ~48 bytes, passwordToken ~200+ chars)
    const needsRefresh =
      !mzAtSslValue ||
      mzAtSslValue === passwordToken ||
      mzAtSslValue.length > 100;

    if (!needsRefresh) {
      // this.logger.debug(
      //   `  ✓ mz_at_ssl 已为真实 session cookie (key=${mzAtSslKey}, ${mzAtSslValue!.length} bytes), 跳过 ensureSessionCookies`,
      // );
      return;
    }

    // this.logger.log(
    //   `  ⚠ mz_at_ssl 缺失或为 passwordToken (key=${mzAtSslKey || '(无)'}, ${mzAtSslValue?.length || 0} bytes), ` +
    //   `需要通过 accountSummary 建立真实 session cookies`,
    // );

    // 通过 accountSummary 获取真实 session cookies — 复用已有的 fetchBalanceViaAccountSummary
    // accountSummary 使用 X-Token 认证, 响应 Set-Cookie 中包含真实的 mz_at_ssl (~48 bytes)
    const balance = await this.fetchBalanceViaAccountSummary(account, sessionCookies, guid, proxy);
    // if (balance) {
    //   this.logger.log(`  ✓ ensureSessionCookies 完成, 同时获取到余额: ${balance}`);
    // } else {
    //   this.logger.log(`  ✓ ensureSessionCookies 完成 (余额未解析, 但 cookies 应已更新)`);
    // }

    // 验证 cookies 是否已更新为真实 session cookie
    let updatedMzAtSsl: string | null = null;
    for (const [key, value] of sessionCookies) {
      if (key === 'mz_at_ssl' || key === `mz_at_ssl-${dsid}` || key.startsWith('mz_at_ssl')) {
        updatedMzAtSsl = value;
        break;
      }
    }

    // if (updatedMzAtSsl && updatedMzAtSsl !== passwordToken && updatedMzAtSsl.length <= 100) {
    //   this.logger.log(`  ✓ mz_at_ssl 已更新为真实 session cookie (${updatedMzAtSsl.length} bytes)`);
    // } else {
    //   this.logger.warn(
    //     `  ⚠ accountSummary 后 mz_at_ssl 仍未更新为真实 session cookie ` +
    //     `(${updatedMzAtSsl?.length || 0} bytes), commerce 请求可能仍会 401`,
    //   );
    // }
  }

  // ==================== Phase 3: 礼品卡兑换 ====================

  /**
   * @description 验证礼品卡代码 — 对标 Java AppleStoreClient.redeemInfo().
   *
   * GET https://buy.itunes.apple.com/commerce/redeemInfo?code=XXX&encodedCode=X16_...
   * 使用 buildAuthHeaders() 构建认证请求头 (cookie + X-Dsid + Anisette).
   *
   * Reference: AppleStoreClient.java L976-1005
   *
   * @param code 16位礼品卡代码 (如 "XYKWN9VM87XRY7VT")
   * @param account 已登录的账号数据
   * @param sessionCookies session cookies
   * @param guid 设备指纹
   * @param proxy 代理实例
   * @returns 原始 JSON 响应字符串
   */
  async redeemInfo(
    code: string,
    account: SessionAccountData,
    sessionCookies: Map<string, string>,
    guid: string,
    proxy: ProxyConfig | null,
  ): Promise<string> {
    // 确保 sessionCookies 中包含真实 mz_at_ssl — 对标 Java ensureSessionCookies()
    // 必须在 commerce 请求前执行, 否则 login 返回的 passwordToken 会导致 401
    await this.ensureSessionCookies(account, sessionCookies, guid, proxy);

    const encodedCode = ItunesClientService.generateEncodedCode(code);
    const pod = account.pod;

    // URL 构造 — pod 存在时替换 host (与 redeemCode 保持一致, session cookie 绑定 pod host)
    let url = `https://buy.itunes.apple.com/commerce/redeemInfo?code=${code}&encodedCode=${encodeURIComponent(encodedCode)}`;
    if (pod) {
      url = url.replace('buy.itunes.apple.com', `p${pod}-buy.itunes.apple.com`);
    }

    // this.logger.log(`>>> 验证礼品卡: ${url}`);
    // this.logger.log(`  code = ${code}, encodedCode = ${encodedCode}`);
    // this.logger.log(`  pod = ${pod || '(无)'}, host = ${pod ? `p${pod}-buy.itunes.apple.com` : 'buy.itunes.apple.com'}`);
    // this.logger.log(`  proxy = ${proxy ? `tag=${proxy.sessionTag || 'random'} (${proxy.host}:${proxy.port})` : '直连'}`);
    // this.logger.log(`  sessionCookies 数量: ${sessionCookies.size}, dsid = ${account.directoryServicesId}`);

    const headers = await this.buildAuthHeaders(account, sessionCookies, guid);
    headers['Accept'] = 'application/json';

    // this.logger.debug(`  Cookie header (前100): ${(headers['Cookie'] || '').substring(0, 100)}...`);

    const response = await this.httpProxyService.requestWithProxy(
      { method: 'GET', url, headers, validateStatus: () => true },
      proxy,
    );

    // axios 可能自动解析 JSON 响应 — 统一序列化为 string
    const body = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);
    this.logger.log(`  响应: HTTP ${response.status} (${body.length} bytes)`);

    // 检测 plist "Sign In" 对话框 — 表示 session 已过期
    const signInDetected = ItunesClientService.detectPlistSignInDialog(body);
    if (signInDetected) {
      this.logger.warn(`  ✘ 验证响应为 plist Sign In 对话框 — session 已过期`);
      return JSON.stringify({
        status: -1,
        errorMessageKey: 'SESSION_EXPIRED',
        userPresentableErrorMessage: 'Session 已过期, Apple 要求重新登录',
      });
    }

    if (response.status !== 200) {
      this.logger.warn(`  ✘ 验证失败 HTTP ${response.status}, body: ${body.substring(0, 200)}`);
    }
    return body;
  }

  /**
   * @description 兑换礼品卡 — 对标 Java AppleStoreClient.redeemCode().
   *
   * POST https://buy.itunes.apple.com/commerce/redeemCodeSrv
   * JSON payload: { code, cameraRecognizedCode, response-content-type, encodedCode, guid }
   *
   * Reference: AppleStoreClient.java L1012-1069
   *
   * @param code 16位礼品卡代码
   * @param account 已登录的账号数据
   * @param sessionCookies session cookies
   * @param guid 设备指纹
   * @param proxy 代理实例
   * @returns { body: 原始 JSON 响应字符串, headers: 响应头对象 }
   */
  async redeemCode(
    code: string,
    account: SessionAccountData,
    sessionCookies: Map<string, string>,
    guid: string,
    proxy: ProxyConfig | null,
  ): Promise<{ body: string; headers: Record<string, any> }> {
    // 确保 sessionCookies 中包含真实 mz_at_ssl — 对标 Java ensureSessionCookies()
    // 必须在 commerce 请求前执行, 否则 login 返回的 passwordToken 会导致 401
    await this.ensureSessionCookies(account, sessionCookies, guid, proxy);

    const encodedCode = ItunesClientService.generateEncodedCode(code);
    const pod = account.pod;

    // URL 构造 — pod 存在时替换 host
    let url = 'https://buy.itunes.apple.com/commerce/redeemCodeSrv';
    if (pod) {
      url = url.replace('buy.itunes.apple.com', `p${pod}-buy.itunes.apple.com`);
    }

    this.logger.log(`>>> 兑换礼品卡: ${url}`);
    this.logger.log(`  code = ${code}, encodedCode = ${encodedCode}`);
    this.logger.log(`  pod = ${pod || '(无)'}, proxy = ${proxy ? `tag=${proxy.sessionTag || 'random'} (${proxy.host}:${proxy.port})` : '直连'}`);
    this.logger.log(`  sessionCookies 数量: ${sessionCookies.size}, dsid = ${account.directoryServicesId}`);

    // 请求 body — 对标 Java L1032-1038
    const payload = {
      code,
      cameraRecognizedCode: false,
      'response-content-type': 'application/json',
      encodedCode,
      guid,
    };

    const headers = await this.buildAuthHeaders(account, sessionCookies, guid);
    headers['Accept'] = 'application/json';
    headers['Content-Type'] = 'application/json';

    const response = await this.httpProxyService.requestWithProxy(
      {
        method: 'POST',
        url,
        data: JSON.stringify(payload),
        headers,
        validateStatus: () => true,
      },
      proxy,
    );

    // axios 可能自动解析 JSON 响应 — 统一序列化为 string, 避免 String(obj) 得到 "[object Object]"
    const body = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);
    // this.logger.log(`  响应: HTTP ${response.status} (${body.length} bytes)`);
    // this.logger.log(`  body: ${body.substring(0, 300)}`);

    // 检测 plist "Sign In" 对话框 — 表示 session 已过期
    // Apple 服务端认为 session 无效时返回 XML plist 而非 JSON, 包含 "Sign In" 按钮
    const signInDetected = ItunesClientService.detectPlistSignInDialog(body);
    if (signInDetected) {
      this.logger.warn(`  ✘ 兑换响应为 plist Sign In 对话框 — session 已过期`);
      return {
        body: JSON.stringify({
          status: -1,
          errorMessageKey: 'SESSION_EXPIRED',
          userPresentableErrorMessage: 'Session 已过期, Apple 要求重新登录',
        }),
        headers: response.headers || {},
      };
    }

    // 解析并记录结果日志 — 对标 Java L1053-1065
    try {
      const result = JSON.parse(body);
      const status = result.status ?? -999;
      if (status === 0) {
        const balance = result.totalCredit?.money || result.creditDisplay || '(未返回)';
        this.logger.log(`  ✓ 兑换成功! 余额: ${balance}`);
      } else {
        const errKey = result.errorMessageKey || '';
        const errMsg = result.userPresentableErrorMessage || '';
        this.logger.warn(`  ✘ 兑换失败: status=${status}, key=${errKey}, msg=${errMsg}`);
      }
    } catch (parseErr: any) {
      // this.logger.warn(`  响应解析失败: ${parseErr.message}, raw(前100): ${body.substring(0, 100)}`);
    }

    return { body, headers: response.headers || {} };
  }

  // ==================== 响应检测工具 ====================

  /**
   * @description 检测响应体是否为 Apple plist "Sign In" 对话框 — 表示 session 已过期.
   *
   * 当 commerce 端点 (redeemCode / redeemInfo) 的 session cookie 失效时,
   * Apple 不会返回 HTTP 401, 而是返回 HTTP 200 + XML plist body,
   * 其中包含 "Sign In" 按钮的对话框结构.
   *
   * 检测策略: body 以 "<?xml" 开头 (或含 "<!DOCTYPE plist") 且包含 "Sign In" 关键词.
   *
   * @param body 响应体字符串
   * @returns true 表示检测到 Sign In 对话框 (session 已过期)
   */
  static detectPlistSignInDialog(body: string): boolean {
    if (!body || body.length === 0) return false;

    const trimmed = body.trimStart();
    const isPlist = trimmed.startsWith('<?xml') || trimmed.includes('<!DOCTYPE plist');
    if (!isPlist) return false;

    // plist 中包含 "Sign In" 按钮 — 确认为 session 过期的登录对话框
    return body.includes('Sign In') || body.includes('okButtonStringKey');
  }

  // ==================== 工具方法 ====================

  /**
   * @description 构造 commerce 端点的认证 headers — 对标 Java buildAuthenticatedRequest().
   *
   * 包含 Cookie (session cookies 拼接) + iCloud-DSID + X-Apple-Store-Front + Anisette headers.
   *
   * Reference: AppleStoreClient.java L1075-1097
   */
  async buildAuthHeaders(
    account: SessionAccountData,
    sessionCookies: Map<string, string>,
    guid: string,
  ): Promise<Record<string, string>> {
    const dsid = account.directoryServicesId;
    const pod = account.pod;
    const cookieStr = ItunesClientService.buildCookieString(dsid, pod, sessionCookies);
    const anisetteHeaders = await this.getAnisetteHeaders();

    return {
      Cookie: cookieStr,
      'iCloud-DSID': dsid,
      'X-Dsid': dsid,
      'X-Apple-Store-Front': account.storeFront || '143465-19,29',
      'User-Agent': 'Configurator/2.15 (Macintosh; OperatingSystem X 11.0.0; 16G29) AppleWebKit/2603.3.8',
      'X-Apple-Tz': '28800',
      ...anisetteHeaders,
    };
  }

  /**
   * @description 构建 session cookie 字符串 — 1:1 对标 Java buildSessionCookieString().
   *
   * 关键映射: mz_at0_fr-{dsid} → mz_at0-{dsid}
   * (login 返回 mz_at0_fr 但 commerce 端点期望 mz_at0)
   *
   * Reference: AppleStoreClient.java L907-952
   */
  static buildCookieString(
    dsid: string,
    pod: string | null,
    sessionCookies: Map<string, string>,
  ): string {
    const parts: string[] = [];

    // 基础 cookie
    parts.push(`X-Dsid=${dsid}`);
    parts.push(`itspod=${pod || '60'}`);

    // 添加 xt-b-ts-{dsid} (时间戳 cookie) — 对标 Java L915-917
    if (!sessionCookies.has(`xt-b-ts-${dsid}`)) {
      parts.push(`xt-b-ts-${dsid}=${Date.now()}`);
    }

    // 追加所有已捕获的真实 session cookies — 对标 Java L920-938
    for (const [k, v] of sessionCookies) {
      if (!v || k === 'X-Dsid' || k === 'itspod') continue;

      // 关键映射: mz_at0_fr → mz_at0 — 对标 Java L927-935
      if (k.startsWith('mz_at0_fr-')) {
        const mappedKey = k.replace('mz_at0_fr-', 'mz_at0-');
        parts.push(`${mappedKey}=${v}`);
        continue;
      }
      if (k === 'mz_at0_fr') {
        parts.push(`mz_at0=${v}`);
        continue;
      }

      parts.push(`${k}=${v}`);
    }

    return parts.join('; ');
  }

  /**
   * @description 生成 encodedCode — 1:1 对标 Java generateEncodedCode().
   *
   * 格式: X{len}_{Base64(String.hashCode(code))}
   * 验证: code="XYKWN9VM87XRY7VT" → hashCode=-607459260 → base64="LTYwNzQ1OTI2MA==" → "X16_LTYwNzQ1OTI2MA=="
   *
   * Reference: AppleStoreClient.java L1104-1109
   */
  static generateEncodedCode(code: string): string {
    const hashCode = ItunesClientService.javaStringHashCode(code);
    const hashStr = String(hashCode);
    const base64Hash = Buffer.from(hashStr, 'utf-8').toString('base64');
    return `X${code.length}_${base64Hash}`;
  }

  /**
   * @description Java String.hashCode() 精确复刻.
   *
   * 算法: s[0]*31^(n-1) + s[1]*31^(n-2) + ... + s[n-1]
   * 使用 32 位有符号整数溢出语义 (JavaScript 需要手动处理).
   *
   * Reference: java.lang.String.hashCode() 源码
   */
  static javaStringHashCode(s: string): number {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      // (hash * 31 + charCode) 需要模拟 Java int32 溢出
      hash = (Math.imul(31, hash) + s.charCodeAt(i)) | 0;
    }
    return hash;
  }

  /**
   * @description 生成设备 GUID — 对标 Java generateGuid().
   *
   * 生成 40 hex 字符的 SHA1 指纹, 用作 Apple 设备唯一标识.
   * 这里使用随机 UUID 生成 (每个会话独立的 GUID).
   *
   * Reference: AppleStoreClient.java L1116-1155
   */
  static generateGuid(): string {
    const crypto = require('crypto');
    const seed = `${Date.now()}-${Math.random()}-apple-store-client-guid-salt`;
    return crypto.createHash('sha1').update(seed).digest('hex');
  }

  /**
   * @description 从响应 Set-Cookie headers 中捕获 cookies — 对标 Java captureResponseCookies().
   *
   * Reference: AppleStoreClient.java L885-896
   */
  private captureSetCookies(
    setCookieHeaders: string[] | string | undefined,
    target: Map<string, string>,
  ): void {
    if (!setCookieHeaders) return;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const val of headers) {
      const eqIdx = val.indexOf('=');
      if (eqIdx === -1) continue;
      const cookieName = val.substring(0, eqIdx);
      let cookieValue = val.substring(eqIdx + 1);
      // 去掉 cookie 属性部分 (path, domain, expires 等)
      const semiIdx = cookieValue.indexOf(';');
      if (semiIdx !== -1) {
        cookieValue = cookieValue.substring(0, semiIdx);
      }
      if (cookieValue) {
        target.set(cookieName, cookieValue);
      }
    }
  }

  /**
   * @description 连接外部 Anisette 服务获取设备认证 headers.
   *
   * Anisette headers 是 Apple 设备认证的组成部分,由外部服务 (localhost:6970) 提供.
   * 服务不可用时返回空对象, 不阻断主流程.
   *
   * Reference: AppleStoreClient.java L489-501
   */
  private async getAnisetteHeaders(): Promise<Record<string, string>> {
    try {
      const response = await this.httpProxyService.request({
        method: 'GET',
        url: ANISETTE_URL,
        timeout: 3000,
        useProxy: false,
        validateStatus: () => true,
      });
      if (response.status === 200 && response.data) {
        const data = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
        // this.logger.debug(`  Anisette headers: ${Object.keys(data).length} 个`);
        return data as Record<string, string>;
      }
    } catch {
      this.logger.warn('  Anisette 不可用');
    }
    return {};
  }
}
