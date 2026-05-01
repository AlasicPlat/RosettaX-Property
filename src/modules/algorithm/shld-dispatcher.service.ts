import { Injectable, Logger } from '@nestjs/common';
import { CookieContainer, HttpProxyService } from '../http-proxy';
import { ShldV1Service } from './shld-v1.service';
import { ProxyConfig } from '../proxy/proxy-config.interface';

/**
 * @file shld-dispatcher.service.ts
 * @description Apple Store SHLD (Shield) PoW 挑战的完整工作流服务.
 *
 * 封装"获取挑战 → 本地求解 → 提交验证"三步流程, 对应 C++ Init() 方法中
 * L1497-1618 的"算法初始化"和"验证算法"两个阶段.
 *
 * 设计意图:
 * - 将 web 签名相关的 SHLD PoW 处理逻辑从业务代码中解耦
 * - 直接注入 ShldV1Service 做本地求解, 避免 HTTP 调自身的开销
 * - 所有出站请求走 HttpProxyService 代理
 *
 * Reference: iTunesAPIs.cpp L1497-1618 (算法初始化 + 验证算法)
 */

/** SHLD PoW 求解 + 验证的入参 */
export interface ShldDispatchParams {
  /** 服务器节点编号 (如 "6", "9"), 用于构建 secure{pod}.store.apple.com */
  pod: string;
  /** 当前请求上下文的 cookies 容器 */
  cookies: CookieContainer;
  /** Sticky session 代理实例 — 整个查询流程锁定同一出口 IP, null 表示直连 */
  proxy?: ProxyConfig | null;
}

/** SHLD PoW 求解 + 验证的返回结果 */
export interface ShldDispatchResult {
  /** 是否成功完成验证 */
  success: boolean;
  /** 错误码 (0=成功, 3=初始化状态码异常, 4=JSON解析失败, 5=算法计算失败, 6=结果解析失败, 7=验证失败, 541=风控, 1000+=网络错误) */
  code: number;
  /** 错误消息 */
  errMsg: string;
  /** 最后一次出错的 HTTP 响应码 */
  responseCode: number;
  /** 验证成功后的 shld_bt_ck cookie 值 */
  shldBtCk?: string;
}

@Injectable()
export class ShldDispatcherService {
  private readonly logger = new Logger(ShldDispatcherService.name);

  constructor(
    private readonly httpProxyService: HttpProxyService,
    private readonly shldV1Service: ShldV1Service,
  ) { }

  /**
   * @description 执行 SHLD PoW 完整工作流: 获取挑战 → 本地求解 → 提交验证.
   *
   * 步骤1: GET /shop/shld/work/v1/q?wd=0 获取 dispatch 挑战数据
   * 步骤2: 调用 ShldV1Service.solve() 本地计算 number + took
   * 步骤3: POST /shop/shld/work/v1/q?wd=0 提交计算结果进行验证
   *
   * @param params 入参, 包含 pod 编号和 cookies 容器
   * @returns 求解验证结果
   */
  async dispatch(params: ShldDispatchParams): Promise<ShldDispatchResult> {
    const { pod, cookies, proxy = null } = params;
    const baseUrl = `https://secure${pod}.store.apple.com/shop/shld/work/v1/q?wd=0`;

    // ── 步骤1: 获取 SHLD PoW 挑战数据 ──
    // this.logger.log('算法初始化 — 获取 PoW 挑战');
    let initResponse;
    try {
      // 使用 sticky proxy 保证与查询流程出口 IP 一致
      initResponse = await this.httpProxyService.requestWithProxy({
        method: 'GET',
        url: baseUrl,
        headers: {
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Cookie': cookies.toRequestString(),
        },
        maxRedirects: 0, // 禁止重定向, 与源码 CURLOPT_FOLLOWLOCATION=0L 一致
        validateStatus: () => true, // 接受所有状态码, 手动判断
      }, proxy);
    } catch (error: any) {
      return {
        success: false,
        code: 1000,
        errMsg: `算法初始化-请求失败: ${error.message}`,
        responseCode: -1,
      };
    }

    // 合并响应 cookies
    cookies.mergeFromSetCookieHeaders(initResponse.headers['set-cookie']);
    cookies.removeEmptyCookies();

    // 风控检测: HTTP 541
    if (initResponse.status === 541) {
      return { success: false, code: 541, errMsg: 'IP被风控', responseCode: 541 };
    }
    if (initResponse.status !== 200) {
      return {
        success: false,
        code: 3,
        errMsg: `算法初始化-状态码不是200，是${initResponse.status}`,
        responseCode: initResponse.status,
      };
    }

    // 解析挑战数据 JSON
    let dispatchData: any;
    try {
      dispatchData = typeof initResponse.data === 'string'
        ? JSON.parse(initResponse.data)
        : initResponse.data;
    } catch {
      return { success: false, code: 4, errMsg: '算法初始化数据json解析失败', responseCode: 200 };
    }

    // 设置 patSkip 标志, 与源码 dispatch_json["flagskv"]["patSkip"] = true 一致
    if (!dispatchData.flagskv) dispatchData.flagskv = {};
    dispatchData.flagskv.patSkip = true;

    // ── 步骤2: 本地求解 PoW (直接调用 ShldV1Service, 无需 HTTP) ──
    // this.logger.log('算法求解 — 本地计算 number + took');
    try {
      const dispatchStr = JSON.stringify(dispatchData);
      // 从 dispatch 数据中提取 v1 所需参数
      const solveResult = await this.shldV1Service.solve({
        parts: dispatchData.parts,
        high: dispatchData.high,
        low: dispatchData.low,
        result: String(dispatchData.result),
      });

      if (!solveResult.number || solveResult.number.length === 0) {
        return { success: false, code: 5, errMsg: '算法计算失败', responseCode: -1 };
      }

      // 将计算结果写回 dispatch 数据
      dispatchData.took = solveResult.took;
      dispatchData.number = solveResult.number;
    } catch (error: any) {
      return { success: false, code: 5, errMsg: `算法计算失败: ${error.message}`, responseCode: -1 };
    }

    // ── 步骤3: 提交验证 ──
    // this.logger.log('算法验证 — 提交 PoW 结果');
    let verifyResponse;
    try {
      // 使用 sticky proxy 保证与查询流程出口 IP 一致
      verifyResponse = await this.httpProxyService.requestWithProxy({
        method: 'POST',
        url: baseUrl,
        data: JSON.stringify(dispatchData),
        headers: {
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': cookies.toRequestString(),
        },
        maxRedirects: 0,
        validateStatus: () => true,
      }, proxy);
    } catch (error: any) {
      return {
        success: false,
        code: 1000,
        errMsg: `算法验证-请求失败: ${error.message}`,
        responseCode: -1,
      };
    }

    // 合并验证响应的 cookies
    cookies.mergeFromSetCookieHeaders(verifyResponse.headers['set-cookie']);
    cookies.removeEmptyCookies();

    if (verifyResponse.status === 541) {
      return { success: false, code: 541, errMsg: 'IP被风控', responseCode: 541 };
    }
    if (verifyResponse.status !== 200) {
      return {
        success: false,
        code: 7,
        errMsg: `算法验证-状态码不是200，是${verifyResponse.status}`,
        responseCode: verifyResponse.status,
      };
    }

    // 提取验证成功后的 shld_bt_ck cookie
    const shldBtCk = cookies.getCookieValue('shld_bt_ck');

    // this.logger.log(`SHLD PoW 验证通过, shld_bt_ck 长度: ${shldBtCk.length}`);

    return {
      success: true,
      code: 0,
      errMsg: '',
      responseCode: 200,
      shldBtCk,
    };
  }
}
