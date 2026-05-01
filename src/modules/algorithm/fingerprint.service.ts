import { Injectable } from '@nestjs/common';

/**
 * @file fingerprint.service.ts
 * @description Apple官网浏览器指纹采集模块 (appidmsparm) — TypeScript 版
 *
 * 功能: 模拟浏览器环境, 生成 X-Apple-I-FD-Client-Info 所需的指纹字符串。
 * 原始代码从 Apple 官网 JS 提取, 经 a_clean.js 清洗后移植为 TypeScript。
 *
 * 核心数据结构:
 *   - tmp: 基础指纹模板 {U: userAgent, L: language, Z: timezone, V: version}
 *   - collectors: 85+ 项指纹采集函数数组, 每项返回一个浏览器环境特征值
 *
 * 输出: 经 Huffman 编码 + CRC16 校验后的压缩指纹字符串
 *
 * Reference: 官网算法服务v0v1/clean/a_clean.js (Apple appleid.apple.com 前端 JS 逆向)
 */
@Injectable()
export class FingerprintService {

  // ==================== 基础指纹模板 ====================
  private readonly tmp = {
    U: "' + user_agent + '",
    L: "' + language + '",
    Z: 'GMT+08:00',
    V: '1.1',
  };

  // ==================== Huffman 编码表 ====================
  // 键为 ASCII 码, 值为 [位数, 编码值] 的 Huffman 码表
  // 用于将指纹字符串中的字符压缩编码
  private readonly huffmanTable: Record<number, [number, number]> = {
    1: [4, 15], 110: [8, 239], 74: [8, 238], 57: [7, 118], 56: [7, 117],
    71: [8, 233], 25: [8, 232], 101: [5, 28], 104: [7, 111], 4: [7, 110],
    105: [6, 54], 5: [7, 107], 109: [7, 106], 103: [9, 423], 82: [9, 422],
    26: [8, 210], 6: [7, 104], 46: [6, 51], 97: [6, 50], 111: [6, 49],
    7: [7, 97], 45: [7, 96], 59: [5, 23], 15: [7, 91], 11: [8, 181],
    72: [8, 180], 27: [8, 179], 28: [8, 178], 16: [7, 88], 88: [10, 703],
    113: [11, 1405], 89: [12, 2809], 107: [13, 5617], 90: [14, 11233],
    42: [15, 22465], 64: [16, 44929], 0: [16, 44928], 81: [9, 350],
    29: [8, 174], 118: [8, 173], 30: [8, 172], 98: [8, 171], 12: [8, 170],
    99: [7, 84], 117: [6, 41], 112: [6, 40], 102: [9, 319], 68: [9, 318],
    31: [8, 158], 100: [7, 78], 84: [6, 38], 55: [6, 37], 17: [7, 73],
    8: [7, 72], 9: [7, 71], 77: [7, 70], 18: [7, 69], 65: [7, 68],
    48: [6, 33], 116: [6, 32], 10: [7, 63], 121: [8, 125], 78: [8, 124],
    80: [7, 61], 69: [7, 60], 119: [7, 59], 13: [8, 117], 79: [8, 116],
    19: [7, 57], 67: [7, 56], 114: [6, 27], 83: [6, 26], 115: [6, 25],
    14: [6, 24], 122: [8, 95], 95: [8, 94], 76: [7, 46], 24: [7, 45],
    37: [7, 44], 50: [5, 10], 51: [5, 9], 108: [6, 17], 22: [7, 33],
    120: [8, 65], 66: [8, 64], 21: [7, 31], 106: [7, 30], 47: [6, 14],
    53: [5, 6], 49: [5, 5], 86: [8, 39], 85: [8, 38], 23: [7, 18],
    75: [7, 17], 20: [7, 16], 2: [5, 3], 73: [8, 23], 43: [9, 45],
    87: [9, 44], 70: [7, 10], 3: [6, 4], 52: [5, 1], 54: [5, 0],
  };

  // ==================== 高频子串替换表 ====================
  // 指纹字符串中最常出现的子串, 将被替换为单字节控制字符以压缩体积
  private readonly FREQUENT_SUBSTRINGS = [
    '%20', ';;;', '%3B', '%2C', 'und', 'fin', 'ed;', '%28', '%29', '%3A',
    '/53', 'ike', 'Web', '0;', '.0', 'e;', 'on', 'il', 'ck', '01', 'in', 'Mo',
    'fa', '00', '32', 'la', '.1', 'ri', 'it', '%u', 'le',
  ];

  // Base64 编码字符集 (自定义, 以 '.' 开头而非标准 base64 的 'A')
  private readonly BASE64_CHARS = '.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

  // 冬季时区偏移 (1月15日)
  private readonly winterOffset = new Date(2005, 0, 15).getTimezoneOffset();
  // 夏季时区偏移 (7月15日)
  private readonly summerOffset = new Date(2005, 6, 15).getTimezoneOffset();

  // ==================== 公开接口 ====================

  /**
   * @description 生成完整的压缩浏览器指纹字符串
   * 等价于原 a_clean.js 的 setFormFingerprint() 无参调用
   * @returns {string} 压缩编码后的指纹字符串 (含 CRC16 校验尾缀)
   */
  generateFingerprint(): string {
    return this.collectFingerprint();
  }

  // ==================== 核心: 浏览器指纹采集 ====================
  /**
   * @description 核心指纹采集函数, 收集浏览器各项环境信息并编码
   * 采集项包括: 浏览器类型标识、ActiveX组件版本、插件列表、时区、
   * 夏令时状态、插件详细版本等共 85+ 项数据点
   *
   * 在 Node.js 环境下, 大多数浏览器相关项返回空字符串或异常信息,
   * 最终输出经 Huffman 压缩 + CRC16 校验
   */
  private collectFingerprint(): string {
    const currentDate = new Date();
    const startTime = new Date();
    const pluginVersions: Record<string, string> = {};
    const winterOffset = this.winterOffset;
    const summerOffset = this.summerOffset;

    /**
     * @description 判断给定日期是否处于夏令时期间
     */
    const isDaylightSavingTime = (date: Date): boolean => {
      const minOffset = Math.min(winterOffset, summerOffset);
      return Math.abs(winterOffset - summerOffset) !== 0 && date.getTimezoneOffset() === minOffset;
    };

    /**
     * @description 模拟 ActiveX 版本检测 (非IE环境下返回 escape 后的错误信息)
     */
    const getActiveXVersion = (clsid: string): string => {
      try {
        // Node.js 环境下无 clientCaps, 抛出异常
        throw new Error('componentVersion is not defined');
      } catch (err: any) {
        const len = Math.min(err.message.length, 40);
        return escape(err.message.substr(0, len));
      }
    };

    // 插件检测 — Node.js 环境下全部为空
    const pluginNames = ['Acrobat', 'Flash', 'QuickTime', 'Java Plug-in', 'Director', 'Office'];
    for (const name of pluginNames) {
      pluginVersions[name] = '';
    }

    // 85+ 项指纹采集函数数组
    const collectors: Array<() => any> = [
      // [0-1] 浏览器类型标识
      () => 'TF1',
      () => '020',
      // [2-4] IE ScriptEngine 版本 (非 IE)
      () => { try { return (globalThis as any).ScriptEngineMajorVersion(); } catch { return ''; } },
      () => { try { return (globalThis as any).ScriptEngineMinorVersion(); } catch { return ''; } },
      () => { try { return (globalThis as any).ScriptEngineBuildVersion(); } catch { return ''; } },
      // [5-22] ActiveX 组件版本检测
      () => getActiveXVersion('{7790769C-0471-11D2-AF11-00C04FA35D02}'),
      () => getActiveXVersion('{89820200-ECBD-11CF-8B85-00AA005B4340}'),
      () => getActiveXVersion('{283807B5-2C60-11D0-A31D-00AA00B92C03}'),
      () => getActiveXVersion('{4F216970-C90C-11D1-B5C7-0000F8051515}'),
      () => getActiveXVersion('{44BBA848-CC51-11CF-AAFA-00AA00B6015C}'),
      () => getActiveXVersion('{9381D8F2-0288-11D0-9501-00AA00B911A5}'),
      () => getActiveXVersion('{4F216970-C90C-11D1-B5C7-0000F8051515}'),
      () => getActiveXVersion('{5A8D6EE0-3E18-11D0-821E-444553540000}'),
      () => getActiveXVersion('{89820200-ECBD-11CF-8B85-00AA005B4383}'),
      () => getActiveXVersion('{08B0E5C0-4FCB-11CF-AAA5-00401C608555}'),
      () => getActiveXVersion('{45EA75A0-A269-11D1-B5BF-0000F8051515}'),
      () => getActiveXVersion('{DE5AED00-A4BF-11D1-9948-00C04F98BBC9}'),
      () => getActiveXVersion('{22D6F312-B0F6-11D0-94AB-0080C74C7E95}'),
      () => getActiveXVersion('{44BBA842-CC51-11CF-AAFA-00AA00B6015B}'),
      () => getActiveXVersion('{3AF36230-A269-11D1-B5BF-0000F8051515}'),
      () => getActiveXVersion('{44BBA840-CC51-11CF-AAFA-00AA00B6015C}'),
      () => getActiveXVersion('{CC2A9BA0-3BDD-11D0-821E-444553540000}'),
      () => getActiveXVersion('{08B0E5C0-4FCB-11CF-AAA5-00401C608500}'),
      // [23-25] 保留空位
      () => '', () => '', () => '',
      // [26] navigator.productSub
      () => '',
      // [27-28] 保留空位
      () => '', () => '',
      // [29] CPU 类型
      () => '',
      // [30-33] 保留空位
      () => '', () => '', () => '', () => '',
      // [34] 浏览器语言
      () => '',
      // [35-41] 保留空位
      () => '', () => '', () => '', () => '', () => '', () => '',
      // [42] 是否支持夏令时
      () => Math.abs(winterOffset - summerOffset) !== 0,
      // [43] 当前是否在夏令时
      () => isDaylightSavingTime(currentDate),
      // [44] UTC 时间戳占位符 (后续替换)
      () => '@UTC@',
      // [45] 时区偏移 (小时)
      () => {
        let dstAdjust = 0;
        if (isDaylightSavingTime(currentDate)) dstAdjust = Math.abs(winterOffset - summerOffset);
        return -(currentDate.getTimezoneOffset() + dstAdjust) / 60;
      },
      // [46] 固定日期的本地化格式
      () => new Date(2005, 5, 7, 21, 33, 44, 888).toLocaleString(),
      // [47-48] 保留空位
      () => '', () => '',
      // [49-54] 主要插件版本号
      () => pluginVersions['Acrobat'],
      () => pluginVersions['Flash'],
      () => pluginVersions['QuickTime'],
      () => pluginVersions['Java Plug-in'],
      () => pluginVersions['Director'],
      () => pluginVersions['Office'],
      // [55] 计时器占位符 (后续替换为采集耗时)
      () => '@CT@',
      // [56-57] 冬季/夏季时区偏移
      () => winterOffset,
      () => summerOffset,
      // [58] 当前时间的本地化格式
      () => currentDate.toLocaleString(),
      // [59-63] 保留空位
      () => '', () => '', () => '', () => '', () => '',
      // [64-81] 各插件的详细名称和描述 (Node.js 环境下全部为空)
      () => '', () => '', () => '', () => '', () => '', () => '',
      () => '', () => '', () => '', () => '', () => '', () => '',
      () => '', () => '', () => '', () => '', () => '', () => '',
      // [82] 非中断空格高度检测 (Node.js 无 DOM, 返回空)
      () => '',
      // [83-96] 14 个空占位符
      () => '', () => '', () => '', () => '', () => '', () => '', () => '',
      () => '', () => '', () => '', () => '', () => '', () => '', () => '',
      // [97] 指纹算法版本号
      () => '5.6.1-0',
      // [98] 空占位符
      () => '',
    ];

    // 遍历所有采集函数, 拼装结果字符串
    let output = '';
    for (let idx = 0; idx < collectors.length; idx++) {
      let value: any;
      try {
        value = collectors[idx]();
      } catch {
        value = '';
      }
      output += escape(value) + ';';
    }

    // 替换 UTC 时间戳和采集耗时的占位符
    output = this.replaceInString(output, escape('@UTC@'), String(new Date().getTime()));
    output = this.replaceInString(output, escape('@CT@'), String(new Date().getTime() - startTime.getTime()));

    // 压缩编码
    return this.compressFingerprint(output);
  }

  // ==================== 字符串替换工具 ====================
  /**
   * @description 在字符串中替换指定子串 (仅首个匹配)
   */
  private replaceInString(str: string, search: string, replacement: string, replaceAll = false): string {
    let isFirst = true;
    let pos: number;
    while ((pos = str.indexOf(search)) >= 0 && (replaceAll || isFirst)) {
      str = str.substr(0, pos) + replacement + str.substr(pos + search.length);
      isFirst = false;
    }
    return str;
  }

  // ==================== Huffman 压缩编码器 ====================
  /**
   * @description 使用自定义 Huffman 编码表将指纹字符串编码为 base64-like 格式
   * @param input 要编码的字符串
   * @returns 编码后的字符串, 如果遇到未知字符则返回 undefined
   */
  private huffmanEncode(input: string): string | undefined {
    let encoded = '';
    let bitBuffer = 0;
    let bitCount = 0;
    const BASE64 = this.BASE64_CHARS;
    const table = this.huffmanTable;

    const writeBits = (bits: [number, number]) => {
      bitBuffer = bitBuffer << bits[0] | bits[1];
      bitCount += bits[0];
      while (bitCount >= 6) {
        const idx = (bitBuffer >> (bitCount - 6)) & 63;
        encoded += BASE64.substring(idx, idx + 1);
        bitBuffer ^= idx << (bitCount -= 6);
      }
    };

    // 写入长度头
    writeBits([6, (7 & input.length) << 3 | 0]);
    writeBits([6, (56 & input.length) | 1]);

    // 逐字符编码
    for (let i = 0; i < input.length; i++) {
      if (table[input.charCodeAt(i)] == null) return undefined;
      writeBits(table[input.charCodeAt(i)]);
    }

    // 写入终止符并刷新剩余位
    writeBits(table[0]);
    if (bitCount > 0) writeBits([6 - bitCount, 0]);

    return encoded;
  }

  // ==================== 指纹压缩主函数 ====================
  /**
   * @description 完整的指纹压缩流程:
   * 1. 用单字节字符替换高频子串 (缩短原始长度)
   * 2. 使用 Huffman 编码进一步压缩
   * 3. 计算 CRC16 校验码拼接在末尾
   *
   * @param rawFingerprint 原始指纹字符串
   * @returns 压缩编码后的指纹字符串 (含 3 字符 CRC 校验尾缀)
   */
  private compressFingerprint(rawFingerprint: string): string {
    // 步骤1: 将高频子串替换为 \x01 ~ \x1F 的单字节控制字符
    let compressed = rawFingerprint;
    for (let i = 0; this.FREQUENT_SUBSTRINGS[i]; i++) {
      compressed = compressed.split(this.FREQUENT_SUBSTRINGS[i]).join(String.fromCharCode(i + 1));
    }

    // 步骤2: Huffman 编码
    const encoded = this.huffmanEncode(compressed);
    if (encoded == null) return rawFingerprint;

    // 步骤3: 计算 CRC16 校验码
    let crc = 65535;
    for (let i = 0; i < rawFingerprint.length; i++) {
      crc = 65535 & (crc >>> 8 | crc << 8);
      crc ^= 255 & rawFingerprint.charCodeAt(i);
      crc ^= (255 & crc) >> 4;
      crc ^= (crc << 12) & 65535;
      crc ^= ((255 & crc) << 5) & 65535;
    }
    crc &= 65535;

    // 将 CRC16 编码为 3 个 base64 字符拼接在 Huffman 编码结果后
    const B64 = this.BASE64_CHARS;
    let crcStr = '';
    crcStr += B64.charAt(crc >>> 12);
    crcStr += B64.charAt((crc >>> 6) & 63);
    crcStr += B64.charAt(63 & crc);

    return encoded + crcStr;
  }
}
