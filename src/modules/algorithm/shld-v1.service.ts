import { Injectable, Logger } from '@nestjs/common';

/**
 * @file shld-v1.service.ts
 * @description Apple官网 SHLD Proof-of-Work V1 算法 (整数因子分解求解) — TypeScript 版
 *
 * 功能: 解决 Apple 官网 SHLD (Shield) 反爬虫机制的 v1 版 PoW 挑战。
 * 原理: 给定一个目标乘积 (result), 找到恰好 parts 个因子,
 *       每个因子在 [low, high] 范围内, 且它们的乘积等于 result。
 *       本质是一个约束回溯搜索问题。
 *
 * 优化历史:
 * - v1.0: 原版回溯搜索 (findFactors) — 基础剪枝, continue 跳过溢出
 * - v1.1: 优化版回溯 (findFactorsOptimized) — break 截断 + 上界剪枝
 *   优化点: 因子非递减遍历, 溢出后 break 而非 continue; 新增上界估算剪枝.
 *   solve() 默认使用优化版, 失败时自动回退原版.
 *
 * Reference: 官网算法服务v0v1/clean/d_clean.js (Apple官网 /shop/shld/work/v1/q 接口)
 */

/** PoW v1 求解参数 */
interface ShldV1Params {
  parts: number;         // 需要的因子个数 (如 4)
  high: number;          // 因子最大值 (如 266)
  low: number;           // 因子最小值 (如 100)
  result: string;        // 目标乘积 (如 "914797400")
  timeout?: number;      // 可选, 超时时间 (ms), 默认 15000ms
}

/** PoW v1 求解结果 */
export interface ShldV1Result {
  number: number[];  // 找到的因子数组 (如 [100, 103, 106, 838]), 超时返回空数组
  took: number;      // 求解耗时 (ms)
}

@Injectable()
export class ShldV1Service {
  private readonly logger = new Logger(ShldV1Service.name);

  /** 默认超时时间: 15秒 */
  private readonly DEFAULT_TIMEOUT_MS = 15_000;

  // ==================== 核心算法: 约束回溯搜索 ====================

  /**
   * @description 通过回溯法搜索满足约束条件的因子组合
   *
   * 约束条件:
   *   1. 找到恰好 targetParts 个因子
   *   2. 每个因子在 [low, high] 范围内
   *   3. 所有因子的乘积等于 targetProduct
   *   4. 在超时时间内完成
   *
   * 剪枝策略:
   *   - 如果当前累积乘积 × 候选因子 > 目标乘积, 跳过 (乘积溢出)
   *   - 如果当前乘积不能整除目标乘积且还需更多因子, 跳过 (不可能凑整)
   *
   * @param low 因子最小值
   * @param high 因子最大值
   * @param targetParts 需要的因子个数
   * @param targetProduct 目标乘积
   * @param startTime 求解开始时间 (ms timestamp)
   * @param timeout 超时时间 (ms)
   * @returns 因子数组, 或 null (超时/无解)
   */
  private async findFactors(
    low: number,
    high: number,
    targetParts: number,
    targetProduct: bigint,
    startTime: number,
    timeout: number,
  ): Promise<number[] | null> {
    const targetPartsBig = BigInt(targetParts);
    const ZERO = 0n;
    const ONE = 1n;

    /**
     * @description 递归回溯搜索
     * @param currentFactors 当前已选的因子数组
     * @param currentProduct 当前已选因子的乘积
     * @param minCandidate 下一个候选因子的最小值 (保证因子非递减, 避免重复组合)
     */
    const backtrack = async (
      currentFactors: number[],
      currentProduct: bigint,
      minCandidate: number,
    ): Promise<number[] | null> => {
      // 超时检测
      if (Date.now() - startTime > timeout) return null;

      // 已选够足够因子数, 检查乘积是否匹配
      if (BigInt(currentFactors.length) === targetPartsBig) {
        if (currentProduct === targetProduct) return [...currentFactors];
        return null;
      }

      // 遍历候选因子
      for (let candidate = minCandidate; candidate <= high; candidate++) {
        if (candidate < low) continue;
        // 剪枝1: 乘积溢出检测
        if (currentProduct * BigInt(candidate) > targetProduct) continue;
        // 剪枝2: 整除性检测 — 如果当前乘积不能整除目标, 且还需多个因子, 跳过
        if (
          targetProduct % (currentProduct * BigInt(candidate)) !== ZERO &&
          BigInt(currentFactors.length) + ONE < targetPartsBig
        ) {
          continue;
        }

        // 选择当前候选因子, 递归搜索下一个
        currentFactors.push(candidate);
        const result = await backtrack(currentFactors, currentProduct * BigInt(candidate), candidate);
        if (result) return result;
        // 回溯: 撤销选择
        currentFactors.pop();
      }

      return null;
    };

    // 从空数组、乘积1、最小候选 low 开始搜索
    return await backtrack([], ONE, low);
  }

  // ==================== 优化版核心算法: 增强剪枝回溯搜索 ====================

  /**
   * @description 优化版回溯搜索 — 在原版 findFactors 基础上增强剪枝策略.
   *
   * 优化点 (相比原版 findFactors):
   *   1. 乘积溢出时 break 而非 continue — 因子非递减, 后续更大的 candidate 必然也溢出
   *   2. 上界估算剪枝 — 如果 currentProduct × candidate × high^remaining < target,
   *      说明即使剩余因子全取最大值也无法达到目标, 跳过
   *   3. 超时检测频率降低 — 每 512 次递归才检查一次, 减少 Date.now() 调用开销
   *
   * 保留原版 findFactors 不做修改, 优化版失败时可回退.
   *
   * @param low 因子最小值
   * @param high 因子最大值
   * @param targetParts 需要的因子个数
   * @param targetProduct 目标乘积
   * @param startTime 求解开始时间 (ms timestamp)
   * @param timeout 超时时间 (ms)
   * @returns 因子数组, 或 null (超时/无解)
   */
  private async findFactorsOptimized(
    low: number,
    high: number,
    targetParts: number,
    targetProduct: bigint,
    startTime: number,
    timeout: number,
  ): Promise<number[] | null> {
    const ZERO = 0n;
    const ONE = 1n;

    // 预计算 high 的幂次表 — 避免递归中重复计算 BigInt(high) ** BigInt(n)
    const highPowers: bigint[] = new Array(targetParts + 1);
    highPowers[0] = ONE;
    const highBig = BigInt(high);
    for (let i = 1; i <= targetParts; i++) {
      highPowers[i] = highPowers[i - 1] * highBig;
    }

    // 递归计数器 — 用于降低超时检测频率
    let recursionCount = 0;

    /**
     * @description 优化版递归回溯搜索
     * @param currentFactors 当前已选的因子数组
     * @param currentProduct 当前已选因子的乘积
     * @param minCandidate 下一个候选因子的最小值 (非递减约束)
     */
    const backtrack = async (
      currentFactors: number[],
      currentProduct: bigint,
      minCandidate: number,
    ): Promise<number[] | null> => {
      // 超时检测: 每 512 次递归检查一次, 减少 Date.now() 系统调用
      if (++recursionCount % 512 === 0 && Date.now() - startTime > timeout) return null;

      const depth = currentFactors.length;

      // 已选够足够因子数, 检查乘积是否匹配
      if (depth === targetParts) {
        return currentProduct === targetProduct ? [...currentFactors] : null;
      }

      const remaining = targetParts - depth - 1;

      for (let candidate = minCandidate; candidate <= high; candidate++) {
        if (candidate < low) continue;

        const nextProduct = currentProduct * BigInt(candidate);

        // 剪枝1 (增强): 乘积溢出 → break 而非 continue
        // 因子非递减遍历, 后续更大的 candidate 乘积只会更大, 全部不可能
        if (nextProduct > targetProduct) break;

        // 剪枝2 (新增): 上界估算 — 剩余因子全取 high 也无法达到目标
        // nextProduct × high^remaining < targetProduct → 无解, 跳过
        if (remaining > 0 && nextProduct * highPowers[remaining] < targetProduct) continue;

        // 剪枝3: 整除性检测 — 当前乘积不能整除目标且还需更多因子, 跳过
        if (remaining > 0 && targetProduct % nextProduct !== ZERO) continue;

        currentFactors.push(candidate);
        const result = await backtrack(currentFactors, nextProduct, candidate);
        if (result) return result;
        currentFactors.pop();
      }

      return null;
    };

    return await backtrack([], ONE, low);
  }

  // ==================== 求解主函数 ====================

  /**
   * @description v1 版 PoW 求解主函数 — 优先使用优化版, 失败时自动回退原版.
   *
   * 策略:
   * 1. 先使用 findFactorsOptimized (增强剪枝版)
   * 2. 如果优化版返回空 (超时/无解), 且耗时 < timeout 的 70%,
   *    用剩余时间回退到原版 findFactors 再试一次
   * 3. 确保任何情况下都有结果返回
   *
   * @param params 求解参数 { parts, high, low, result, timeout? }
   * @returns 求解结果 { number: [factors], took: ms }
   */
  async solve(params: ShldV1Params): Promise<ShldV1Result> {
    const startTime = Date.now();
    const timeout = params.timeout || this.DEFAULT_TIMEOUT_MS;
    const targetProduct = BigInt(params.result);

    // ── 优先: 优化版求解 ──
    let factors = await this.findFactorsOptimized(
      params.low,
      params.high,
      params.parts,
      targetProduct,
      startTime,
      timeout,
    );

    if (factors && factors.length > 0) {
      const took = Date.now() - startTime;
      this.logger.debug(`[SHLD-V1] 优化版求解成功: took=${took}ms, factors=[${factors.join(',')}]`);
      return { number: factors, took };
    }

    // ── 回退: 原版求解 (如果还有剩余时间) ──
    const elapsed = Date.now() - startTime;
    const remainingTimeout = timeout - elapsed;

    // 仅当剩余时间 > 2s 时才回退, 否则直接返回空
    if (remainingTimeout > 2000) {
      this.logger.warn(
        `[SHLD-V1] 优化版未找到解 (${elapsed}ms), 回退原版求解 (剩余 ${remainingTimeout}ms)`,
      );
      factors = await this.findFactors(
        params.low,
        params.high,
        params.parts,
        targetProduct,
        Date.now(),
        remainingTimeout,
      );

      if (factors && factors.length > 0) {
        const took = Date.now() - startTime;
        this.logger.log(`[SHLD-V1] 原版回退求解成功: took=${took}ms, factors=[${factors.join(',')}]`);
        return { number: factors, took };
      }
    }

    // 两版均失败
    const took = Date.now() - startTime;
    this.logger.warn(`[SHLD-V1] 两版求解均失败: took=${took}ms`);
    return { number: [], took };
  }
}
