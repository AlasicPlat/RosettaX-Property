/**
 * @fileoverview 美国州/领地编码常量
 * @description 从 Apple 官网 changeCountry 接口的 addressOfficialStateProvince 字段提取
 *              包含美国 50 州 + DC + 海外领地 + 军事分部
 */

/** 美国州/领地信息 */
export interface USStateInfo {
  /** 中文显示名 */
  readonly displayNameZh: string;
  /** 英文名称 */
  readonly name: string;
  /** 州代码 (两位字母) */
  readonly code: string;
}

/**
 * 美国全部州、特区、海外领地及军事分部
 * @remarks 50 州 + DC + 6 海外领地 + 3 军事分部 = 60 条
 */
export const US_STATES: readonly USStateInfo[] = [
  // ── 50 States ──
  { displayNameZh: '亚拉巴马州', name: 'Alabama', code: 'AL' },
  { displayNameZh: '阿拉斯加州', name: 'Alaska', code: 'AK' },
  { displayNameZh: '亚利桑那州', name: 'Arizona', code: 'AZ' },
  { displayNameZh: '阿肯色州', name: 'Arkansas', code: 'AR' },
  { displayNameZh: '加利福尼亚州', name: 'California', code: 'CA' },
  { displayNameZh: '科罗拉多州', name: 'Colorado', code: 'CO' },
  { displayNameZh: '康涅狄格州', name: 'Connecticut', code: 'CT' },
  { displayNameZh: '特拉华州', name: 'Delaware', code: 'DE' },
  { displayNameZh: '佛罗里达州', name: 'Florida', code: 'FL' },
  { displayNameZh: '佐治亚州', name: 'Georgia', code: 'GA' },
  { displayNameZh: '夏威夷州', name: 'Hawaii', code: 'HI' },
  { displayNameZh: '爱达荷州', name: 'Idaho', code: 'ID' },
  { displayNameZh: '伊利诺伊州', name: 'Illinois', code: 'IL' },
  { displayNameZh: '印第安纳州', name: 'Indiana', code: 'IN' },
  { displayNameZh: '艾奥瓦州', name: 'Iowa', code: 'IA' },
  { displayNameZh: '堪萨斯州', name: 'Kansas', code: 'KS' },
  { displayNameZh: '肯塔基州', name: 'Kentucky', code: 'KY' },
  { displayNameZh: '路易斯安那州', name: 'Louisiana', code: 'LA' },
  { displayNameZh: '缅因州', name: 'Maine', code: 'ME' },
  { displayNameZh: '马里兰州', name: 'Maryland', code: 'MD' },
  { displayNameZh: '马萨诸塞州', name: 'Massachusetts', code: 'MA' },
  { displayNameZh: '密歇根州', name: 'Michigan', code: 'MI' },
  { displayNameZh: '明尼苏达州', name: 'Minnesota', code: 'MN' },
  { displayNameZh: '密西西比州', name: 'Mississippi', code: 'MS' },
  { displayNameZh: '密苏里州', name: 'Missouri', code: 'MO' },
  { displayNameZh: '蒙大拿州', name: 'Montana', code: 'MT' },
  { displayNameZh: '内布拉斯加州', name: 'Nebraska', code: 'NE' },
  { displayNameZh: '内华达州', name: 'Nevada', code: 'NV' },
  { displayNameZh: '新罕布什尔州', name: 'New Hampshire', code: 'NH' },
  { displayNameZh: '新泽西州', name: 'New Jersey', code: 'NJ' },
  { displayNameZh: '新墨西哥州', name: 'New Mexico', code: 'NM' },
  { displayNameZh: '纽约州', name: 'New York', code: 'NY' },
  { displayNameZh: '北卡罗来纳州', name: 'North Carolina', code: 'NC' },
  { displayNameZh: '北达科他州', name: 'North Dakota', code: 'ND' },
  { displayNameZh: '俄亥俄州', name: 'Ohio', code: 'OH' },
  { displayNameZh: '俄克拉何马州', name: 'Oklahoma', code: 'OK' },
  { displayNameZh: '俄勒冈州', name: 'Oregon', code: 'OR' },
  { displayNameZh: '宾夕法尼亚州', name: 'Pennsylvania', code: 'PA' },
  { displayNameZh: '罗得岛', name: 'Rhode Island', code: 'RI' },
  { displayNameZh: '南卡罗来纳州', name: 'South Carolina', code: 'SC' },
  { displayNameZh: '南达科他州', name: 'South Dakota', code: 'SD' },
  { displayNameZh: '田纳西州', name: 'Tennessee', code: 'TN' },
  { displayNameZh: '得克萨斯州', name: 'Texas', code: 'TX' },
  { displayNameZh: '犹他州', name: 'Utah', code: 'UT' },
  { displayNameZh: '佛蒙特州', name: 'Vermont', code: 'VT' },
  { displayNameZh: '弗吉尼亚州', name: 'Virginia', code: 'VA' },
  { displayNameZh: '华盛顿州', name: 'Washington', code: 'WA' },
  { displayNameZh: '西弗吉尼亚州', name: 'West Virginia', code: 'WV' },
  { displayNameZh: '威斯康星州', name: 'Wisconsin', code: 'WI' },
  { displayNameZh: '怀俄明州', name: 'Wyoming', code: 'WY' },
  // ── District & Territories ──
  { displayNameZh: '哥伦比亚特区', name: 'District of Columbia', code: 'DC' },
  { displayNameZh: '美属萨摩亚', name: 'American Samoa', code: 'AS' },
  { displayNameZh: '关岛', name: 'Guam', code: 'GU' },
  { displayNameZh: '北马里亚纳群岛', name: 'Northern Mariana Islands', code: 'MP' },
  { displayNameZh: '波多黎各', name: 'Puerto Rico', code: 'PR' },
  { displayNameZh: '美国本土外小岛屿', name: 'Minor Outlying Islands', code: 'UM' },
  { displayNameZh: '维尔京群岛', name: 'Virgin Islands', code: 'VI' },
  // ── Armed Forces ──
  { displayNameZh: '美洲军事分部', name: 'Armed Forces Americas', code: 'AA' },
  { displayNameZh: '欧洲军事分部', name: 'Armed Forces Europe', code: 'AE' },
  { displayNameZh: '太平洋军事分部', name: 'Armed Forces Pacific', code: 'AP' },
] as const;

/**
 * 按州代码快速查找
 * @example US_STATE_BY_CODE.get('CA') => { displayNameZh: '加利福尼亚州', name: 'California', code: 'CA' }
 */
export const US_STATE_BY_CODE: ReadonlyMap<string, USStateInfo> = new Map(
  US_STATES.map((s) => [s.code, s]),
);
