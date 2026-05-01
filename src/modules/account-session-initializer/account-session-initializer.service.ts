import { Injectable, Logger } from '@nestjs/common';
import {
  CookieContainer,
  CookieJarService,
  HttpProxyService,
} from '../http-proxy';
import { DistributedLockService } from '../distributed-cache';
import { ShldDispatcherService } from '../algorithm/shld-dispatcher.service';
import { ProxyConfig } from '../proxy/proxy-config.interface';
import { AccountSessionCacheService } from '../account-session-cache/account-session-cache.service';
import {
  AccountInfo,
  AccountSessionContext,
  QueryResult,
} from './account-session-context.interface';
import {
  buildInterfaceResponseLog,
  maskLogIdentifier,
} from '../../utils/interface-response-log.util';

/**
 * @file account-session-initializer.service.ts
 * @description Apple Store 查询上下文初始化服务.
 *
 * 职责只保留账号慢链路:
 * 1. loginAccount() 获取 Apple IDMSA 登录 cookie.
 * 2. initContext() 初始化可复用的 Apple Store 查询上下文.
 * 3. initializeQuerySession() 将上下文和 cookies 写入共享 Redis session 缓存.
 *
 * 该服务不执行余额查询, 也不承接任何业务 API。
 */
@Injectable()
export class AccountSessionInitializerService {
  private readonly logger = new Logger(AccountSessionInitializerService.name);

  /**
   * @description 注入上下文初始化所需依赖.
   * @param httpProxyService 代理 HTTP 客户端
   * @param cookieJarService Cookie 容器工厂
   * @param shldDispatcherService SHLD PoW 调度器
   * @param lockService 分布式锁服务, 防止同一账号地区并发初始化
   * @param sessionCacheService 查询 session 缓存服务
   */
  constructor(
    private readonly httpProxyService: HttpProxyService,
    private readonly cookieJarService: CookieJarService,
    private readonly shldDispatcherService: ShldDispatcherService,
    private readonly lockService: DistributedLockService,
    private readonly sessionCacheService: AccountSessionCacheService,
  ) { }

  // ==================== 辅助方法 ====================


  /**
   * @description 从 HTML 内容中提取 init_data JSON — 解析 <script id="init_data"> 标签内的 JSON 数据.
   *
   * Apple Store 页面将关键配置 (如签名 token、回调 URL) 嵌入在
   * <script id="init_data" type="application/json">...</script> 中.
   *
   * @param html 页面 HTML 内容
   * @returns 解析后的 JSON 对象, 解析失败返回 null
   */
  private extractInitData(html: string): any | null {
    const marker = '<script id="init_data" type="application/json">';
    const pos = html.indexOf(marker);
    if (pos === -1) return null;

    const startIdx = pos + marker.length;
    const endIdx = html.indexOf('</script>', startIdx);
    if (endIdx === -1) return null;

    const jsonStr = html.substring(startIdx, endIdx);
    try {
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  /**
   * @description 从 URL 中提取 Apple Store 服务器节点编号 (pod).
   *
   * Apple Store 使用 secure{N}.store.apple.com 的格式路由请求到不同后端 pod,
   * N 是一个数字 (如 6, 9), 从页面返回的回调 URL 中提取.
   *
   * @param url 包含 secure{N}.store.apple.com 的 URL
   * @returns pod 编号字符串, 默认 "9"
   */
  private extractPod(url: string): string {
    const pos = url.indexOf('secure');
    if (pos === -1) return '9';

    const afterSecure = pos + 6; // "secure".length
    const dotPos = url.indexOf('.', afterSecure);
    if (dotPos === -1) return '9';

    return url.substring(afterSecure, dotPos) || '9';
  }

  /**
   * @description 从 URL 中提取 host 部分 — 用于拼接查询 API 的完整 URL.
   * @param url 完整 URL
   * @returns host 部分 (如 "secure6.store.apple.com")
   */
  private extractHost(url: string): string {
    const doubleSlash = url.indexOf('//');
    if (doubleSlash === -1) return '';

    const afterSlash = doubleSlash + 2;
    const nextSlash = url.indexOf('/', afterSlash);
    if (nextSlash === -1) return url.substring(afterSlash);

    return url.substring(afterSlash, nextSlash);
  }

  // ==================== 核心方法1: 登录 ====================

  /**
   * @description Apple IDMSA 表单登录 — 遍历账号池直到获得 myacinfo cookie.
   *
   * 对应 C++ login() L1256-1408. 完整逻辑:
   * 1. 检查账号池是否为空
   * 2. 如果 nextAccount=true, 切换到下一个账号
   * 3. 循环尝试各账号, 跳过已标记为不可用的
   * 4. POST https://idmsa.apple.com/authenticate 发起登录
   * 5. 检查响应 cookies 中是否包含 myacinfo
   * 6. 没有 myacinfo 则标记当前账号不可用, 切换下一个
   * 7. 所有账号都失败则返回 code=15
   *
   * @param context 查询上下文
   * @param nextAccount 是否强制切换到下一个账号 (风控后需要)
   * @param proxy 代理实例 (null 表示直连)
   * @returns QueryResult
   */
  private async loginAccount(
    context: AccountSessionContext,
    nextAccount: boolean = false,
    proxy: ProxyConfig | null = null,
  ): Promise<QueryResult> {
    const ret: QueryResult = { code: 0, pos: 0, errMsg: '', responseCode: -1 };

    // this.logger.log(`[loginAccount] 开始登录 — 账号池大小: ${context.accountInfoList.length}, nextAccount: ${nextAccount}, 当前索引: ${context.currentAccountIndex}`);

    // 账号池为空检查
    if (context.accountInfoList.length === 0) {
      this.logger.error('[loginAccount] 账号列表为空');
      context.internalReturnCode = 14;
      return { ...ret, code: 14, errMsg: '账号列表为空' };
    }

    // 需要切换账号时, 递增索引 (循环)
    if (nextAccount) {
      if (context.currentAccountIndex < context.accountInfoList.length - 1) {
        context.currentAccountIndex++;
      } else {
        context.currentAccountIndex = 0;
      }
      this.logger.log(`[loginAccount] 切换账号 → 索引: ${context.currentAccountIndex}`);
    }

    const url = 'https://idmsa.apple.com/authenticate';
    let success = false;
    const startIndex = context.currentAccountIndex;
    /** 503 代理切换计数器 — 防止无限切换代理 */
    const MAX_PROXY_SWITCH_TIMES = 3;
    let proxySwitchTimes = 0;

    while (!success) {
      const accStr = context.accountInfoList[context.currentAccountIndex].acc;
      const pwdStr = context.accountInfoList[context.currentAccountIndex].pwd;

      // this.logger.log(`[loginAccount] 尝试账号 [${context.currentAccountIndex}]: ${accStr.substring(0, 6)}***`);

      // 跳过已标记为不可用的账号 — 避免重复尝试已知失败的账号
      if (!context.accountInfoList[context.currentAccountIndex].available) {
        this.logger.log(`[loginAccount] ${accStr.substring(0, 6)}*** 缓存检测不可用, 跳过`);
        if (context.currentAccountIndex < context.accountInfoList.length - 1) {
          context.currentAccountIndex++;
        } else {
          context.currentAccountIndex = 0;
        }
        // 绕了一圈回到起点, 说明所有账号都不可用
        if (startIndex === context.currentAccountIndex) {
          this.logger.warn('缓存阶段检查了所有账号，均登录失败');
          context.internalReturnCode = 15;
          return { ...ret, code: 15, errMsg: '所有账号均登录失败' };
        }
        continue;
      }

      // 构建登录 POST 数据
      const postData = `appleId=${accStr}&accountPassword=${pwdStr}&appIdKey=a797929d224abb1cc663bb187bbcd02f7172ca3a84df470380522a7c6092118b&accNameLocked=false&language=CN-ZH&requestUri=/login&Env=PROD`;

      let result;
      try {
        result = await this.httpProxyService.requestWithProxy({
          method: 'POST',
          url,
          data: postData,
          headers: {
            'Connection': 'keep-alive',
            'Cache-Control': 'max-age=0',
            'Upgrade-Insecure-Requests': '1',
            'Origin': 'https://idmsa.apple.com',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
            'Referer': 'https://idmsa.apple.com/IDMSWebAuth/classicLogin.html?appIdKey=a797929d224abb1cc663bb187bbcd02f7172ca3a84df470380522a7c6092118b',
            'Accept-Language': 'zh-CN, en;q=0.9, *;q=0.1',
          },
          maxRedirects: 0, // 不允许重定向, 与源码 CURLOPT_FOLLOWLOCATION=0L 一致
          validateStatus: () => true,
        }, proxy);
      } catch (error: any) {
        // 网络层失败 (CURL 错误等价)
        this.logger.error(`[loginAccount] 请求失败: ${error.message}`);
        context.internalReturnCode = 1000;
        return { ...ret, code: 1000, errMsg: `登录-请求失败: ${error.message}` };
      }

      // this.logger.log(`[loginAccount] HTTP 响应状态码: ${result.status}, Set-Cookie 数量: ${(result.headers['set-cookie'] || []).length}`);

      // IP 被风控 (HTTP 503) — 自动切换代理后重试当前账号
      if (result.status === 503) {
        proxySwitchTimes++;
        if (proxySwitchTimes >= MAX_PROXY_SWITCH_TIMES) {
          // 连续切换代理仍然 503, 所有出口 IP 可能都被封, 返回让上层处理
          this.logger.error(`[loginAccount] 连续 ${proxySwitchTimes} 次 503, 代理资源可能全部被封`);
          context.beRiskCtrl = true;
          context.internalReturnCode = 503;
          return { ...ret, code: 503, responseCode: 503, errMsg: `连续${proxySwitchTimes}次切换代理仍被风控(503)` };
        }
        this.logger.warn(`[loginAccount] IP 被风控 (503), 自动切换代理重试 (${proxySwitchTimes}/${MAX_PROXY_SWITCH_TIMES})`);
        proxy = this.httpProxyService.acquireRandomProxy();
        this.logger.log(`[loginAccount] 切换到新代理: sessionTag=${proxy.sessionTag || 'random'}, ${proxy.host}:${proxy.port}`);
        // 不切换账号, 用新 IP 重试同一个账号 — 503 是 IP 问题而非账号问题
        continue;
      }

      // 检查响应 cookies 中是否包含 myacinfo — 登录成功的唯一判据
      const setCookies = result.headers['set-cookie'] as string[] | undefined;
      const loginCookies = new CookieContainer();
      loginCookies.mergeFromSetCookieHeaders(setCookies);
      this.logger.log(buildInterfaceResponseLog(
        'context.loginAccount.response',
        result,
        undefined,
        {
          method: 'POST',
          url,
          account: maskLogIdentifier(accStr),
          loginCookieCount: loginCookies.size,
          hasMyacinfo: loginCookies.isExist('myacinfo'),
        },
      ));

      if (!loginCookies.isExist('myacinfo')) {
        // 登录失败: myacinfo cookie 不存在
        this.logger.warn(`[loginAccount] ${accStr.substring(0, 6)}*** 登录失败 — myacinfo 不存在, 状态码: ${result.status}`);
        context.accountInfoList[context.currentAccountIndex].available = false;
        context.accountInfoList[context.currentAccountIndex].isLogin = false;

        // 切换到下一个账号
        if (context.currentAccountIndex < context.accountInfoList.length - 1) {
          context.currentAccountIndex++;
        } else {
          context.currentAccountIndex = 0;
        }
        // 绕了一圈回到起点, 所有账号均失败
        if (startIndex === context.currentAccountIndex) {
          this.logger.warn('所有账号均登录失败');
          context.internalReturnCode = 15;
          return { ...ret, code: 15, responseCode: result.status, errMsg: '所有账号均登录失败' };
        }
        success = false;
      } else {
        // 登录成功: 缓存 cookies 供后续使用
        // this.logger.log(`[loginAccount] ✅ ${accStr.substring(0, 6)}*** 登录成功! cookies 数量: ${(setCookies || []).length}`);
        context.accountInfoList[context.currentAccountIndex].isLogin = true;
        context.accountInfoList[context.currentAccountIndex].available = true;

        // 将 Set-Cookie 解析结果存入账号的 loginCookies map
        if (setCookies) {
          for (const header of setCookies) {
            const nameValue = header.split(';')[0]?.trim();
            if (!nameValue) continue;
            const eqIdx = nameValue.indexOf('=');
            if (eqIdx === -1) continue;
            const name = nameValue.substring(0, eqIdx).trim();
            const value = nameValue.substring(eqIdx + 1).trim();
            if (name) {
              context.accountInfoList[context.currentAccountIndex].loginCookies.set(name, value);
            }
          }
        }
        success = true;
      }
    }

    return ret;
  }

  // ==================== 核心方法2: 初始化查询上下文 ====================

  /**
   * @description 初始化礼品卡查询上下文 — 完整的多步流程.
   *
   * 对应 C++ Init() L1410-1787. 步骤:
   * 1. GET 查询页面 → 手动跟随重定向逐跳收集 cookies → 提取 init_data (x-aos-stk, 回调 URL)
   * 2. SHLD PoW 验证 (通过 ShldDispatcherService)
   * 3. POST 登录验证回调 (带 x-aos-stk)
   * 4. GET 跳转页面 → 手动跟随重定向 → 提取 x-as-actk + 查询 URL
   *
   * ★ 核心修复: 步骤1和步骤4使用 requestWithCookies() 手动跟随重定向,
   * 每一跳收集 Set-Cookie, 解决 callbackSignInUrl 为空的问题.
   *
   * @param context 查询上下文
   * @param cookies Cookie 容器
   * @param proxy 代理实例
   * @returns QueryResult
   */
  private async initContext(
    context: AccountSessionContext,
    cookies: CookieContainer,
    proxy: ProxyConfig | null = null,
  ): Promise<QueryResult> {
    const ret: QueryResult = { code: 0, pos: 0, errMsg: '', responseCode: -1 };

    // ── 步骤1: 进入查询页面 — 使用手动重定向逐跳收集 cookies ──
    ret.pos++;
    const urlSuffix = 'com';
    const balanceUrl = `https://secure.store.apple.${urlSuffix}${context.countryURL}/shop/giftcard/balance`;
    // this.logger.log(`[initContext] ── 步骤1: 进入查询页面 — 地区: ${context.countryURL}, URL: ${balanceUrl}`);

    // 合并当前账号的登录 cookies 到请求容器
    const currentAccount = context.accountInfoList[context.currentAccountIndex];
    // this.logger.log(`[initContext] 当前账号: ${currentAccount.acc.substring(0, 6)}***, loginCookies 数量: ${currentAccount.loginCookies.size}, isLogin: ${currentAccount.isLogin}`);

    // 使用 CookieContainer 的方式合并
    const loginContainer = this.cookieJarService.createContainer();
    for (const [name, value] of currentAccount.loginCookies) {
      loginContainer.mergeFromSetCookieHeaders([`${name}=${value}`]);
    }
    cookies.mergeFrom(loginContainer);
    // this.logger.log(`[initContext] cookies 合并完成, 总 cookie 数量: ${cookies.size}`);
    // this.logger.debug(`[initContext] Cookie 字符串长度: ${cookies.toRequestString().length}`);

    let result;
    try {
      // ★ 核心修复: 使用 requestWithCookies() 手动跟随重定向, 逐跳收集 cookies
      // 解决 axios 自动重定向丢失中间 Set-Cookie 导致 callbackSignInUrl 为空的问题
      // 对标 C++ V2 Init() L2193-2266 的三步手动重定向逻辑
      result = await this.httpProxyService.requestWithCookies({
        method: 'GET',
        url: balanceUrl,
        interfaceLogLabel: 'context.init.balance-page',
        headers: {
          'Upgrade-Insecure-Requests': '1',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
          'Accept-Language': 'zh-CN, en;q=0.9, *;q=0.1',
        },
      }, cookies, proxy);
    } catch (error: any) {
      context.internalReturnCode = 1000;
      return { ...ret, code: 1000, errMsg: `进入查询页面-请求失败: ${error.message}` };
    }

    // this.logger.log(`[initContext] 查询页面响应 — 状态码: ${result.status}, 数据长度: ${typeof result.data === 'string' ? result.data.length : 'N/A'}`);

    // 风控检测 — 541 和 503 都是 IP 级别的风控
    if (result.status === 541 || result.status === 503) {
      this.logger.error(`[initContext] IP 被风控 (${result.status})`);
      context.beRiskCtrl = true;
      context.internalReturnCode = result.status;
      return { ...ret, code: result.status, responseCode: result.status, errMsg: 'IP被风控' };
    }
    if (result.status !== 200) {
      this.logger.error(`[initContext] 查询页面状态码异常: ${result.status}`);
      context.internalReturnCode = 1000;
      return { ...ret, code: 1000, responseCode: result.status, errMsg: `进入查询页面-请求失败，状态码: ${result.status}` };
    }

    // ★ 此处不再需要手动 mergeFromSetCookieHeaders — requestWithCookies() 已在每跳中收集

    // 提取 init_data — 包含 x-aos-stk 和回调登录 URL
    const html = typeof result.data === 'string' ? result.data : String(result.data);
    const initData = this.extractInitData(html);
    if (!initData) {
      this.logger.warn(`[initContext] ❌ 没找到 init_data — HTML 长度: ${html.length}, 前200字符: ${html.substring(0, 200)}`);
      context.internalReturnCode = 1;
      return { ...ret, code: 1, errMsg: '没找到init_data，返回代码1' };
    }
    this.logger.log(buildInterfaceResponseLog(
      'context.init.balance-page.initData',
      result,
      initData,
      {
        method: 'GET',
        url: balanceUrl,
        account: maskLogIdentifier(currentAccount.acc),
        accumulatedCookieCount: cookies.size,
      },
    ));
    // this.logger.log('[initContext] ✅ init_data 解析成功');

    let xAosStk: string;
    let callbackSignInUrl: string;
    try {
      xAosStk = initData.meta?.h?.['x-aos-stk'] || '';
      callbackSignInUrl = initData.signIn?.customerLoginIDMS?.d?.callbackSignInUrl || '';
    } catch {
      context.internalReturnCode = 2;
      return { ...ret, code: 2, errMsg: 'json解析失败，返回代码2' };
    }

    // this.logger.log(`[initContext] x-aos-stk: ${xAosStk ? xAosStk.substring(0, 20) + '...' : '(空)'}, callbackSignInUrl: ${callbackSignInUrl || '(空)'}`);

    if (!callbackSignInUrl) {
      this.logger.error('[initContext] 回调登录 URL 为空');
      context.internalReturnCode = 2;
      return { ...ret, code: 2, errMsg: '回调登录 URL 为空' };
    }

    // 从回调 URL 提取 pod 编号 (如 secure6.store → pod = "6")
    const pod = this.extractPod(callbackSignInUrl);
    // this.logger.log(`[initContext] ── 步骤2: SHLD PoW 验证 — pod: ${pod}`);

    // ── 步骤2: SHLD PoW 验证 (通过 ShldDispatcherService) ──
    ret.pos++;
    const shldResult = await this.shldDispatcherService.dispatch({ pod, cookies, proxy });
    // this.logger.log(`[initContext] SHLD 结果 — success: ${shldResult.success}, code: ${shldResult.code}`);
    if (!shldResult.success) {
      context.internalReturnCode = shldResult.code;
      if (shldResult.code === 541) context.beRiskCtrl = true;
      return {
        ...ret,
        code: shldResult.code,
        responseCode: shldResult.responseCode,
        errMsg: shldResult.errMsg,
      };
    }

    // ── 步骤3: 登录验证 — POST 到回调 URL ──
    ret.pos++;
    // this.logger.log(`[initContext] ── 步骤3: 登录验证 — POST ${callbackSignInUrl}`);
    let verifyResult;
    try {
      verifyResult = await this.httpProxyService.requestWithProxy({
        method: 'POST',
        url: callbackSignInUrl,
        data: '',
        headers: {
          'Connection': 'keep-alive',
          'sec-ch-ua-platform': '"Windows"',
          'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
          'x-aos-model-page': 'signInPage',
          'sec-ch-ua-mobile': '?0',
          'syntax': 'graviton',
          'modelVersion': 'v2',
          'x-aos-stk': xAosStk,
          'X-Requested-With': 'Fetch',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': '*/*',
          'Origin': `https://secure${pod}.store.apple.com`,
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Cookie': cookies.toRequestString(),
        },
        maxRedirects: 0,
        validateStatus: () => true,
      }, proxy);
    } catch (error: any) {
      context.internalReturnCode = 1000;
      return { ...ret, code: 1000, errMsg: `登录验证-请求失败: ${error.message}` };
    }

    // this.logger.log(`[initContext] 登录验证响应 — 状态码: ${verifyResult.status}`);
    cookies.mergeFromSetCookieHeaders(verifyResult.headers['set-cookie']);
    // 这一步请求会删除登录 cookies, 需要重新合并 — 与源码 L1657 行为一致
    cookies.mergeFrom(loginContainer);

    if (verifyResult.status === 541 || verifyResult.status === 503) {
      context.beRiskCtrl = true;
      context.internalReturnCode = verifyResult.status;
      return { ...ret, code: verifyResult.status, responseCode: verifyResult.status, errMsg: 'IP被风控' };
    }
    if (verifyResult.status !== 200) {
      context.internalReturnCode = 8;
      return { ...ret, code: 8, responseCode: verifyResult.status, errMsg: `登录验证-状态码不是200，是${verifyResult.status}` };
    }

    // 解析登录验证响应, 获取跳转 URL
    let verifyData: any;
    try {
      verifyData = typeof verifyResult.data === 'string'
        ? JSON.parse(verifyResult.data)
        : verifyResult.data;
    } catch {
      this.logger.log(buildInterfaceResponseLog(
        'context.init.verify-signin.response',
        verifyResult,
        undefined,
        {
          method: 'POST',
          url: callbackSignInUrl,
          account: maskLogIdentifier(currentAccount.acc),
          accumulatedCookieCount: cookies.size,
        },
      ));
      context.internalReturnCode = 9;
      return { ...ret, code: 9, errMsg: '获取登录成功后的地址-JSON解析失败' };
    }
    this.logger.log(buildInterfaceResponseLog(
      'context.init.verify-signin.response',
      verifyResult,
      verifyData,
      {
        method: 'POST',
        url: callbackSignInUrl,
        account: maskLogIdentifier(currentAccount.acc),
        accumulatedCookieCount: cookies.size,
      },
    ));

    let nextUrl: string = verifyData?.head?.data?.url || '';
    // this.logger.log(`[initContext] 跳转 URL: ${nextUrl || '(空)'}`);
    if (!nextUrl) {
      context.internalReturnCode = 9;
      return { ...ret, code: 9, errMsg: '获取登录成功后的地址为空' };
    }

    // 如果跳转 URL 包含 signIn, 说明账号未正确登录
    if (nextUrl.includes('signIn')) {
      this.logger.warn('[initContext] ❌ 跳转 URL 包含 signIn, 账号未正确登录');
      context.internalReturnCode = 16;
      return { ...ret, code: 16, errMsg: '登录验证-账号未登录' };
    }

    // ── 步骤4: 登录完成, 获取查询页面 — 同样使用手动重定向收集 cookies ──
    ret.pos++;
    // this.logger.log(`[initContext] ── 步骤4: 登录完成, 获取查询页面 — GET ${nextUrl}`);
    let queryPageResult;
    try {
      // ★ 步骤4也使用 requestWithCookies(), 跳转页面可能有额外重定向
      queryPageResult = await this.httpProxyService.requestWithCookies({
        method: 'GET',
        url: nextUrl,
        interfaceLogLabel: 'context.init.login-completed-page',
        headers: {
          'Upgrade-Insecure-Requests': '1',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
          'Accept-Language': 'zh-CN, en;q=0.9, *;q=0.1',
        },
      }, cookies, proxy);
    } catch (error: any) {
      context.internalReturnCode = 1000;
      return { ...ret, code: 1000, errMsg: `登录完成即将查询-请求失败: ${error.message}` };
    }

    // ★ 不再需要手动 mergeFromSetCookieHeaders — requestWithCookies() 已在每跳中收集

    if (queryPageResult.status === 541 || queryPageResult.status === 503) {
      context.beRiskCtrl = true;
      context.internalReturnCode = queryPageResult.status;
      return { ...ret, code: queryPageResult.status, responseCode: queryPageResult.status, errMsg: 'IP被风控' };
    }
    if (queryPageResult.status !== 200) {
      context.internalReturnCode = 10;
      return { ...ret, code: 10, responseCode: queryPageResult.status, errMsg: `登录完成即将查询-状态码不是200，是${queryPageResult.status}` };
    }

    // 从查询页面提取 x-as-actk 和查询 URL
    const queryPageHtml = typeof queryPageResult.data === 'string' ? queryPageResult.data : String(queryPageResult.data);
    const queryInitData = this.extractInitData(queryPageHtml);
    // this.logger.log(`[initContext] 查询页面响应 — 状态码: ${queryPageResult.status}, 数据长度: ${queryPageHtml.length}`);
    if (!queryInitData) {
      this.logger.warn('[initContext] ❌ 查询页面 init_data 获取失败');
      context.internalReturnCode = 11;
      return { ...ret, code: 11, errMsg: '登录完成即将查询-init_data获取失败' };
    }
    this.logger.log(buildInterfaceResponseLog(
      'context.init.login-completed-page.initData',
      queryPageResult,
      queryInitData,
      {
        method: 'GET',
        url: nextUrl,
        account: maskLogIdentifier(currentAccount.acc),
        accumulatedCookieCount: cookies.size,
      },
    ));

    let xAsActk: string;
    let queryUrl: string;
    try {
      xAsActk = queryInitData.meta?.h?.['x-as-actk'] || '';
      queryUrl = queryInitData.giftCardBalanceCheck?.a?.checkBalance?.url || '';
    } catch {
      context.internalReturnCode = 12;
      return { ...ret, code: 12, errMsg: '登录完成即将查询-init_data解析失败' };
    }

    if (!queryUrl) {
      context.internalReturnCode = 12;
      return { ...ret, code: 12, errMsg: '查询 URL 为空' };
    }

    // 拼接完整的查询 URL — host 从跳转 URL 中提取
    const host = this.extractHost(nextUrl);
    queryUrl = `https://${host}${queryUrl}`;

    // 将关键 token 写入上下文
    context.queryURL = queryUrl;
    context.x_aos_stk = xAosStk;
    context.x_as_actk = xAsActk;
    context.internalReturnCode = 0;

    this.logger.log(`[initContext] ✅ 上下文初始化完成 — queryURL: ${queryUrl}`);
    // this.logger.log(`[initContext] x-aos-stk: ${xAosStk.substring(0, 20)}..., x-as-actk: ${xAsActk ? xAsActk.substring(0, 20) + '...' : '(空)'}`);
    // this.logger.log(`[initContext] cookies 总量: ${cookies.size}`);
    return { ...ret, code: 0 };
  }

  /**
   * @description 使用指定账号列表创建查询上下文 — 不从数据库读取, 由调用方直接提供.
   *
   * 用于客户端提交的用户账号池场景: 账号信息由前端传入, 绕过 query_account_pool 数据库表.
   *
   * @param countryURL 国家/地区路径 (如 "/us")
   * @param accounts 账号列表 [{email, password}]
   * @returns 初始化完成的 AccountSessionContext, 账号列表为空时返回 null
   */
  private createContextFromAccounts(
    countryURL: string,
    accounts: Array<{ email: string; password: string; accountKey?: string; groupId?: number | null }>,
  ): AccountSessionContext | null {
    if (accounts.length === 0) {
      this.logger.warn('提供的账号列表为空, 无法创建上下文');
      return null;
    }

    const accountInfoList: AccountInfo[] = accounts.map((acc) => ({
      acc: acc.email,
      pwd: acc.password,
      available: true,
      isLogin: false,
      loginCookies: new Map<string, string>(),
    }));

    return {
      currentAccountIndex: 0,
      accountInfoList,
      x_aos_stk: '',
      x_as_actk: '',
      server: '',
      countryURL,
      queryURL: '',
      internalReturnCode: 0,
      beRiskCtrl: false,
      maxAttemptReached: false,
    };
  }


  /**
   * @description 初始化可缓存的查询 session — 执行 login + init 流程并缓存 session.
   *
   * 仅初始化 session (不执行实际查询), 完成后 session 被缓存,
   * 后续查询通过 getAccountForRegion 的预热索引自动选中该 session.
   *
   * @param cacheKey 目标 cacheKey
   * @param countryURL 区域路径
   * @param accounts 账号列表 (目标账号在首位)
   */
  async initializeQuerySession(
    cacheKey: string,
    countryURL: string,
    accounts: Array<{ email: string; password: string; accountKey?: string; groupId?: number | null }>,
  ): Promise<boolean> {
    // 获取分布式锁 — 防止与正常查询或其他 Pod 冲突
    const lock = await this.lockService.acquire(cacheKey);

    try {
      // 如果已经有缓存了 (可能被其他 Pod 抢先初始化), 直接返回
      const hasExisting = await this.sessionCacheService.hasValidSession(cacheKey);
      if (hasExisting) {
        this.logger.log(`[warmup] session 已存在, 跳过预热: key=${cacheKey}`);
        return true;
      }

      const context = this.createContextFromAccounts(countryURL, accounts);
      if (!context) return false;

      const cookies = this.cookieJarService.createContainer();
      const proxy = this.httpProxyService.acquireRandomProxy();

      // Step 1: 登录
      const loginResult = await this.loginAccount(context, false, proxy);
      if (loginResult.code !== 0) {
        cookies.destroy();
        this.logger.warn(`[warmup] 登录失败: key=${cacheKey}, code=${loginResult.code}`);
        return false;
      }

      // Step 2: 初始化上下文
      const initResult = await this.initContext(context, cookies, this.httpProxyService.acquireRandomProxy());
      if (initResult.code !== 0) {
        cookies.destroy();
        this.logger.warn(`[warmup] 初始化失败: key=${cacheKey}, code=${initResult.code}, pos=${initResult.pos}, err=${initResult.errMsg}`);
        return false;
      }

      // 缓存 session 到 Redis — 后续查询可直接使用
      await this.sessionCacheService.saveSession(cacheKey, context, cookies);
      cookies.destroy(); // 序列化后释放本地副本
      this.logger.log(`[warmup] ✅ 预热完成: key=${cacheKey}`);
      return true;
    } finally {
      await lock.release();
    }
  }

}
