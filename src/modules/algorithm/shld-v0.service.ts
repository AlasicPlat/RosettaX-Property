import { Injectable } from '@nestjs/common';
import { webcrypto } from 'crypto';

/**
 * @file shld-v0.service.ts
 * @description Apple官网 SHLD Proof-of-Work V0 算法 (HashCash / SHA-256 碰撞求解) — TypeScript 版
 *
 * 功能: 解决 Apple 官网 SHLD (Shield) 反爬虫机制的 v0 版 PoW 挑战。
 * 原理: 给定一个 salt 和目标 challenge hash, 遍历 nonce 值 (0 ~ 1000000),
 *       计算 SHA-256(salt + nonce), 直到结果匹配 challenge。
 *
 * Reference: 官网算法服务v0v1/clean/c_clean.js (Apple官网 /shop/shld/work/v0/q 接口)
 */

/** PoW v0 求解参数 */
interface ShldV0Params {
  challenge: string;  // 目标 SHA-256 哈希值 (hex 字符串)
  salt: string;       // 盐值 (hex 字符串)
  algorithm: string;  // 哈希算法名 (如 "SHA-256")
  timeout?: number;   // 可选, 超时时间 (ms), 默认 15000ms
}

/** PoW v0 求解结果 */
export interface ShldV0Result {
  number: number;  // 找到的 nonce 值
  took: number;    // 求解耗时 (ms)
}

@Injectable()
export class ShldV0Service {

  // ==================== 常量定义 ====================
  /** 最大尝试次数: 100万次 */
  private readonly MAX_ITERATIONS = 1_000_000;
  /** 默认超时时间: 15秒 */
  private readonly DEFAULT_TIMEOUT_MS = 15_000;
  /** 文本编码器, 用于将字符串转为 Uint8Array 供 crypto.subtle.digest 使用 */
  private readonly textEncoder = new TextEncoder();

  // ==================== 辅助函数 ====================

  /**
   * @description 将 ArrayBuffer 转换为十六进制字符串
   * @param buffer 哈希计算返回的 ArrayBuffer
   * @returns 小写十六进制字符串
   */
  private bufferToHex(buffer: ArrayBuffer): string {
    return [...new Uint8Array(buffer)]
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * @description 计算 salt + nonce 的哈希值 (单次尝试)
   * 包含超时检测: 如果从 startTime 算起已超过 timeout, 则返回 undefined 表示放弃
   *
   * @param salt 盐值字符串
   * @param nonce 当前尝试的 nonce 值
   * @param algorithm 哈希算法 (如 "SHA-256")
   * @param startTime 求解开始时间
   * @param timeout 超时时间 (ms)
   * @returns 哈希结果 hex 字符串, 超时则返回 undefined
   */
  private async computeHash(
    salt: string,
    nonce: number,
    algorithm: string,
    startTime: number,
    timeout: number,
  ): Promise<string | undefined> {
    // 超时检测
    if (Date.now() - startTime > timeout) return undefined;

    // 计算 SHA-256(salt + nonce) 并返回 hex 字符串
    const digest = await webcrypto.subtle.digest(
      algorithm.toUpperCase(),
      this.textEncoder.encode(salt + nonce),
    );
    return this.bufferToHex(digest);
  }

  // ==================== 求解主函数 ====================

  /**
   * @description v0 版 PoW 求解主函数
   * 遍历 nonce 从 0 到 MAX_ITERATIONS, 逐个计算哈希, 直到匹配 challenge 或超时
   *
   * @param params 求解参数 { challenge, salt, algorithm, timeout? }
   * @returns 求解结果 { number: nonce, took: ms }
   */
  async solve(params: ShldV0Params): Promise<ShldV0Result> {
    const startTime = Date.now();
    const timeout = params.timeout || this.DEFAULT_TIMEOUT_MS;
    let hashResult: string | undefined = undefined;
    let nonce = 0;

    // 逐一尝试 nonce, 计算 hash 直到匹配 challenge
    for (; nonce < this.MAX_ITERATIONS; nonce++) {
      hashResult = await this.computeHash(
        params.salt,
        nonce,
        params.algorithm,
        startTime,
        timeout,
      );
      // 哈希结果匹配 challenge → 找到答案; 或 hashResult 为 undefined → 超时
      if (hashResult === params.challenge || hashResult === undefined) break;
    }

    return {
      number: nonce,
      took: Date.now() - startTime,
    };
  }
}
