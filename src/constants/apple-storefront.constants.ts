/**
 * @fileoverview Apple iTunes Store 国家/地区编码常量
 * @description 从 Apple 官网 editAccountFields/get?context=changeCountry 接口提取
 *              包含 ISO 3166-1 alpha-3 国家代码、英文名、中文名、国际区号
 */

/** 单个国家/地区店面信息 */
export interface AppleStorefront {
  /** 中文显示名 */
  readonly displayNameZh: string;
  /** 英文名称 */
  readonly name: string;
  /** ISO 3166-1 alpha-3 国家代码 (Apple 使用的 value) */
  readonly countryCode: string;
  /** 国际电话区号 */
  readonly dialCode: string;
}

/**
 * Apple iTunes Store 全部可用国家/地区店面列表
 * @remarks 按照 Apple API 原始返回顺序（中文拼音排序）
 */
export const APPLE_STOREFRONTS: readonly AppleStorefront[] = [
  { displayNameZh: '阿尔巴尼亚', name: 'Albania', countryCode: 'ALB', dialCode: '355' },
  { displayNameZh: '阿尔及利亚', name: 'Algeria', countryCode: 'DZA', dialCode: '213' },
  { displayNameZh: '阿富汗', name: 'Afghanistan', countryCode: 'AFG', dialCode: '93' },
  { displayNameZh: '阿根廷', name: 'Argentina', countryCode: 'ARG', dialCode: '54' },
  { displayNameZh: '阿联酋', name: 'United Arab Emirates', countryCode: 'ARE', dialCode: '971' },
  { displayNameZh: '阿曼', name: 'Oman', countryCode: 'OMN', dialCode: '968' },
  { displayNameZh: '阿塞拜疆', name: 'Azerbaijan', countryCode: 'AZE', dialCode: '994' },
  { displayNameZh: '埃及', name: 'Egypt', countryCode: 'EGY', dialCode: '20' },
  { displayNameZh: '爱尔兰', name: 'Ireland', countryCode: 'IRL', dialCode: '353' },
  { displayNameZh: '爱沙尼亚', name: 'Estonia', countryCode: 'EST', dialCode: '372' },
  { displayNameZh: '安哥拉', name: 'Angola', countryCode: 'AGO', dialCode: '244' },
  { displayNameZh: '安圭拉岛', name: 'Anguilla', countryCode: 'AIA', dialCode: '1264' },
  { displayNameZh: '安提瓜和巴布达', name: 'Antigua and Barbuda', countryCode: 'ATG', dialCode: '1268' },
  { displayNameZh: '奥地利', name: 'Austria', countryCode: 'AUT', dialCode: '43' },
  { displayNameZh: '澳大利亚', name: 'Australia', countryCode: 'AUS', dialCode: '61' },
  { displayNameZh: '澳门', name: 'Macau', countryCode: 'MAC', dialCode: '853' },
  { displayNameZh: '巴巴多斯', name: 'Barbados', countryCode: 'BRB', dialCode: '1246' },
  { displayNameZh: '巴布亚新几内亚', name: 'Papua New Guinea', countryCode: 'PNG', dialCode: '675' },
  { displayNameZh: '巴哈马', name: 'Bahamas', countryCode: 'BHS', dialCode: '1242' },
  { displayNameZh: '巴基斯坦', name: 'Pakistan', countryCode: 'PAK', dialCode: '92' },
  { displayNameZh: '巴拉圭', name: 'Paraguay', countryCode: 'PRY', dialCode: '595' },
  { displayNameZh: '巴林', name: 'Bahrain', countryCode: 'BHR', dialCode: '973' },
  { displayNameZh: '巴拿马', name: 'Panama', countryCode: 'PAN', dialCode: '507' },
  { displayNameZh: '巴西', name: 'Brazil', countryCode: 'BRA', dialCode: '55' },
  { displayNameZh: '白俄罗斯', name: 'Belarus', countryCode: 'BLR', dialCode: '375' },
  { displayNameZh: '百慕大', name: 'Bermuda', countryCode: 'BMU', dialCode: '1441' },
  { displayNameZh: '保加利亚', name: 'Bulgaria', countryCode: 'BGR', dialCode: '359' },
  { displayNameZh: '北马其顿', name: 'North Macedonia', countryCode: 'MKD', dialCode: '389' },
  { displayNameZh: '贝宁', name: 'Benin', countryCode: 'BEN', dialCode: '229' },
  { displayNameZh: '比利时', name: 'Belgium', countryCode: 'BEL', dialCode: '32' },
  { displayNameZh: '冰岛', name: 'Iceland', countryCode: 'ISL', dialCode: '354' },
  { displayNameZh: '玻利维亚', name: 'Bolivia', countryCode: 'BOL', dialCode: '591' },
  { displayNameZh: '波兰', name: 'Poland', countryCode: 'POL', dialCode: '48' },
  { displayNameZh: '波斯尼亚和黑塞哥维那', name: 'Bosnia and Herzegovina', countryCode: 'BIH', dialCode: '387' },
  { displayNameZh: '博茨瓦纳', name: 'Botswana', countryCode: 'BWA', dialCode: '267' },
  { displayNameZh: '伯利兹', name: 'Belize', countryCode: 'BLZ', dialCode: '501' },
  { displayNameZh: '不丹', name: 'Bhutan', countryCode: 'BTN', dialCode: '975' },
  { displayNameZh: '布基纳法索', name: 'Burkina Faso', countryCode: 'BFA', dialCode: '226' },
  { displayNameZh: '丹麦', name: 'Denmark', countryCode: 'DNK', dialCode: '45' },
  { displayNameZh: '德国', name: 'Germany', countryCode: 'DEU', dialCode: '49' },
  { displayNameZh: '多米尼加共和国', name: 'Dominican Republic', countryCode: 'DOM', dialCode: '1' },
  { displayNameZh: '多米尼克', name: 'Dominica', countryCode: 'DMA', dialCode: '1767' },
  { displayNameZh: '俄罗斯', name: 'Russia', countryCode: 'RUS', dialCode: '7' },
  { displayNameZh: '厄瓜多尔', name: 'Ecuador', countryCode: 'ECU', dialCode: '593' },
  { displayNameZh: '法国', name: 'France', countryCode: 'FRA', dialCode: '33' },
  { displayNameZh: '菲律宾', name: 'Philippines', countryCode: 'PHL', dialCode: '63' },
  { displayNameZh: '芬兰', name: 'Finland', countryCode: 'FIN', dialCode: '358' },
  { displayNameZh: '佛得角', name: 'Cape Verde', countryCode: 'CPV', dialCode: '238' },
  { displayNameZh: '冈比亚', name: 'Gambia', countryCode: 'GMB', dialCode: '220' },
  { displayNameZh: '刚果共和国', name: 'Congo, Republic of', countryCode: 'COG', dialCode: '242' },
  { displayNameZh: '刚果民主共和国', name: 'Congo, Democratic Republic of', countryCode: 'COD', dialCode: '243' },
  { displayNameZh: '哥伦比亚', name: 'Colombia', countryCode: 'COL', dialCode: '57' },
  { displayNameZh: '哥斯达黎加', name: 'Costa Rica', countryCode: 'CRI', dialCode: '506' },
  { displayNameZh: '格林纳达', name: 'Grenada', countryCode: 'GRD', dialCode: '1473' },
  { displayNameZh: '格鲁吉亚', name: 'Georgia', countryCode: 'GEO', dialCode: '995' },
  { displayNameZh: '圭亚那', name: 'Guyana', countryCode: 'GUY', dialCode: '592' },
  { displayNameZh: '哈萨克斯坦', name: 'Kazakhstan', countryCode: 'KAZ', dialCode: '7' },
  { displayNameZh: '韩国', name: 'South Korea', countryCode: 'KOR', dialCode: '82' },
  { displayNameZh: '荷兰', name: 'Netherlands', countryCode: 'NLD', dialCode: '31' },
  { displayNameZh: '黑山', name: 'Montenegro', countryCode: 'MNE', dialCode: '382' },
  { displayNameZh: '洪都拉斯', name: 'Honduras', countryCode: 'HND', dialCode: '504' },
  { displayNameZh: '吉尔吉兹斯坦', name: 'Kyrgyzstan', countryCode: 'KGZ', dialCode: '996' },
  { displayNameZh: '几内亚比绍', name: 'Guinea-Bissau', countryCode: 'GNB', dialCode: '245' },
  { displayNameZh: '加拿大', name: 'Canada', countryCode: 'CAN', dialCode: '1' },
  { displayNameZh: '加纳', name: 'Ghana', countryCode: 'GHA', dialCode: '233' },
  { displayNameZh: '加蓬', name: 'Gabon', countryCode: 'GAB', dialCode: '241' },
  { displayNameZh: '柬埔寨', name: 'Cambodia', countryCode: 'KHM', dialCode: '855' },
  { displayNameZh: '捷克', name: 'Czechia', countryCode: 'CZE', dialCode: '420' },
  { displayNameZh: '津巴布韦', name: 'Zimbabwe', countryCode: 'ZWE', dialCode: '263' },
  { displayNameZh: '喀麦隆', name: 'Cameroon', countryCode: 'CMR', dialCode: '237' },
  { displayNameZh: '卡塔尔', name: 'Qatar', countryCode: 'QAT', dialCode: '974' },
  { displayNameZh: '开曼群岛', name: 'Cayman Islands', countryCode: 'CYM', dialCode: '1345' },
  { displayNameZh: '科索沃', name: 'Kosovo', countryCode: 'XKS', dialCode: '383' },
  { displayNameZh: '科特迪瓦', name: "Cote D'Ivoire", countryCode: 'CIV', dialCode: '225' },
  { displayNameZh: '科威特', name: 'Kuwait', countryCode: 'KWT', dialCode: '965' },
  { displayNameZh: '克罗地亚', name: 'Croatia', countryCode: 'HRV', dialCode: '385' },
  { displayNameZh: '肯尼亚', name: 'Kenya', countryCode: 'KEN', dialCode: '254' },
  { displayNameZh: '拉脱维亚', name: 'Latvia', countryCode: 'LVA', dialCode: '371' },
  { displayNameZh: '老挝', name: 'Laos', countryCode: 'LAO', dialCode: '856' },
  { displayNameZh: '黎巴嫩', name: 'Lebanon', countryCode: 'LBN', dialCode: '961' },
  { displayNameZh: '利比里亚', name: 'Liberia', countryCode: 'LBR', dialCode: '231' },
  { displayNameZh: '利比亚', name: 'Libya', countryCode: 'LBY', dialCode: '218' },
  { displayNameZh: '立陶宛', name: 'Lithuania', countryCode: 'LTU', dialCode: '370' },
  { displayNameZh: '卢森堡', name: 'Luxembourg', countryCode: 'LUX', dialCode: '352' },
  { displayNameZh: '卢旺达', name: 'Rwanda', countryCode: 'RWA', dialCode: '250' },
  { displayNameZh: '罗马尼亚', name: 'Romania', countryCode: 'ROU', dialCode: '40' },
  { displayNameZh: '马达加斯加', name: 'Madagascar', countryCode: 'MDG', dialCode: '261' },
  { displayNameZh: '马耳他', name: 'Malta', countryCode: 'MLT', dialCode: '356' },
  { displayNameZh: '马尔代夫', name: 'Maldives', countryCode: 'MDV', dialCode: '960' },
  { displayNameZh: '马拉维', name: 'Malawi', countryCode: 'MWI', dialCode: '265' },
  { displayNameZh: '马来西亚', name: 'Malaysia', countryCode: 'MYS', dialCode: '60' },
  { displayNameZh: '马里', name: 'Mali', countryCode: 'MLI', dialCode: '223' },
  { displayNameZh: '毛里求斯', name: 'Mauritius', countryCode: 'MUS', dialCode: '230' },
  { displayNameZh: '毛里塔尼亚', name: 'Mauritania', countryCode: 'MRT', dialCode: '222' },
  { displayNameZh: '美国', name: 'United States', countryCode: 'USA', dialCode: '1' },
  { displayNameZh: '蒙古', name: 'Mongolia', countryCode: 'MNG', dialCode: '976' },
  { displayNameZh: '蒙特塞拉特', name: 'Montserrat', countryCode: 'MSR', dialCode: '1664' },
  { displayNameZh: '秘鲁', name: 'Peru', countryCode: 'PER', dialCode: '51' },
  { displayNameZh: '密克罗尼西亚', name: 'Micronesia', countryCode: 'FSM', dialCode: '691' },
  { displayNameZh: '缅甸', name: 'Myanmar', countryCode: 'MMR', dialCode: '95' },
  { displayNameZh: '摩尔多瓦', name: 'Moldova', countryCode: 'MDA', dialCode: '373' },
  { displayNameZh: '摩洛哥', name: 'Morocco', countryCode: 'MAR', dialCode: '212' },
  { displayNameZh: '莫桑比克', name: 'Mozambique', countryCode: 'MOZ', dialCode: '258' },
  { displayNameZh: '墨西哥', name: 'Mexico', countryCode: 'MEX', dialCode: '52' },
  { displayNameZh: '纳米比亚', name: 'Namibia', countryCode: 'NAM', dialCode: '264' },
  { displayNameZh: '南非', name: 'South Africa', countryCode: 'ZAF', dialCode: '27' },
  { displayNameZh: '尼泊尔', name: 'Nepal', countryCode: 'NPL', dialCode: '977' },
  { displayNameZh: '尼加拉瓜', name: 'Nicaragua', countryCode: 'NIC', dialCode: '505' },
  { displayNameZh: '尼日尔州', name: 'Niger', countryCode: 'NER', dialCode: '227' },
  { displayNameZh: '尼日利亚', name: 'Nigeria', countryCode: 'NGA', dialCode: '234' },
  { displayNameZh: '挪威', name: 'Norway', countryCode: 'NOR', dialCode: '47' },
  { displayNameZh: '帕劳', name: 'Palau', countryCode: 'PLW', dialCode: '680' },
  { displayNameZh: '葡萄牙', name: 'Portugal', countryCode: 'PRT', dialCode: '351' },
  { displayNameZh: '日本', name: 'Japan', countryCode: 'JPN', dialCode: '81' },
  { displayNameZh: '瑞典', name: 'Sweden', countryCode: 'SWE', dialCode: '46' },
  { displayNameZh: '瑞士', name: 'Switzerland', countryCode: 'CHE', dialCode: '41' },
  { displayNameZh: '萨尔瓦多', name: 'El Salvador', countryCode: 'SLV', dialCode: '503' },
  { displayNameZh: '塞尔维亚', name: 'Serbia', countryCode: 'SRB', dialCode: '381' },
  { displayNameZh: '塞拉利昂', name: 'Sierra Leone', countryCode: 'SLE', dialCode: '232' },
  { displayNameZh: '塞内加尔', name: 'Senegal', countryCode: 'SEN', dialCode: '221' },
  { displayNameZh: '塞浦路斯', name: 'Cyprus', countryCode: 'CYP', dialCode: '357' },
  { displayNameZh: '塞舌尔', name: 'Seychelles', countryCode: 'SYC', dialCode: '248' },
  { displayNameZh: '沙特阿拉伯', name: 'Saudi Arabia', countryCode: 'SAU', dialCode: '966' },
  { displayNameZh: '圣多美和普林西比', name: 'São Tomé and Príncipe', countryCode: 'STP', dialCode: '239' },
  { displayNameZh: '圣基茨和尼维斯', name: 'Saint Kitts and Nevis', countryCode: 'KNA', dialCode: '1869' },
  { displayNameZh: '圣卢西亚', name: 'Saint Lucia', countryCode: 'LCA', dialCode: '1758' },
  { displayNameZh: '圣文森特和格林纳丁斯', name: 'Saint Vincent and the Grenadines', countryCode: 'VCT', dialCode: '1784' },
  { displayNameZh: '斯里兰卡', name: 'Sri Lanka', countryCode: 'LKA', dialCode: '94' },
  { displayNameZh: '斯洛伐克', name: 'Slovakia', countryCode: 'SVK', dialCode: '421' },
  { displayNameZh: '斯洛文尼亚', name: 'Slovenia', countryCode: 'SVN', dialCode: '386' },
  { displayNameZh: '斯威士兰', name: 'Eswatini', countryCode: 'SWZ', dialCode: '268' },
  { displayNameZh: '苏里南', name: 'Suriname', countryCode: 'SUR', dialCode: '597' },
  { displayNameZh: '所罗门群岛', name: 'Solomon Islands', countryCode: 'SLB', dialCode: '677' },
  { displayNameZh: '塔吉克斯坦', name: 'Tajikistan', countryCode: 'TJK', dialCode: '992' },
  { displayNameZh: '台湾', name: 'Taiwan', countryCode: 'TWN', dialCode: '886' },
  { displayNameZh: '泰国', name: 'Thailand', countryCode: 'THA', dialCode: '66' },
  { displayNameZh: '坦桑尼亚', name: 'Tanzania', countryCode: 'TZA', dialCode: '255' },
  { displayNameZh: '汤加', name: 'Tonga', countryCode: 'TON', dialCode: '676' },
  { displayNameZh: '特克斯和凯科斯群岛', name: 'Turks and Caicos', countryCode: 'TCA', dialCode: '1649' },
  { displayNameZh: '特立尼达和多巴哥', name: 'Trinidad and Tobago', countryCode: 'TTO', dialCode: '1868' },
  { displayNameZh: '突尼斯', name: 'Tunisia', countryCode: 'TUN', dialCode: '216' },
  { displayNameZh: '土耳其', name: 'Türkiye', countryCode: 'TUR', dialCode: '90' },
  { displayNameZh: '土库曼斯坦', name: 'Turkmenistan', countryCode: 'TKM', dialCode: '993' },
  { displayNameZh: '瓦努阿图', name: 'Vanuatu', countryCode: 'VUT', dialCode: '678' },
  { displayNameZh: '危地马拉', name: 'Guatemala', countryCode: 'GTM', dialCode: '502' },
  { displayNameZh: '委内瑞拉', name: 'Venezuela', countryCode: 'VEN', dialCode: '58' },
  { displayNameZh: '文莱', name: 'Brunei', countryCode: 'BRN', dialCode: '673' },
  { displayNameZh: '乌干达', name: 'Uganda', countryCode: 'UGA', dialCode: '256' },
  { displayNameZh: '乌克兰', name: 'Ukraine', countryCode: 'UKR', dialCode: '380' },
  { displayNameZh: '乌拉圭', name: 'Uruguay', countryCode: 'URY', dialCode: '598' },
  { displayNameZh: '乌兹别克斯坦', name: 'Uzbekistan', countryCode: 'UZB', dialCode: '998' },
  { displayNameZh: '西班牙', name: 'Spain', countryCode: 'ESP', dialCode: '34' },
  { displayNameZh: '希腊', name: 'Greece', countryCode: 'GRC', dialCode: '30' },
  { displayNameZh: '香港', name: 'Hong Kong', countryCode: 'HKG', dialCode: '852' },
  { displayNameZh: '新加坡', name: 'Singapore', countryCode: 'SGP', dialCode: '65' },
  { displayNameZh: '新西兰', name: 'New Zealand', countryCode: 'NZL', dialCode: '64' },
  { displayNameZh: '匈牙利', name: 'Hungary', countryCode: 'HUN', dialCode: '36' },
  { displayNameZh: '牙买加', name: 'Jamaica', countryCode: 'JAM', dialCode: '1876' },
  { displayNameZh: '亚美尼亚', name: 'Armenia', countryCode: 'ARM', dialCode: '374' },
  { displayNameZh: '也门', name: 'Yemen', countryCode: 'YEM', dialCode: '967' },
  { displayNameZh: '伊拉克', name: 'Iraq', countryCode: 'IRQ', dialCode: '964' },
  { displayNameZh: '以色列', name: 'Israel', countryCode: 'ISR', dialCode: '972' },
  { displayNameZh: '意大利', name: 'Italy', countryCode: 'ITA', dialCode: '39' },
  { displayNameZh: '印度', name: 'India', countryCode: 'IND', dialCode: '91' },
  { displayNameZh: '印度尼西亚', name: 'Indonesia', countryCode: 'IDN', dialCode: '62' },
  { displayNameZh: '英国', name: 'United Kingdom', countryCode: 'GBR', dialCode: '44' },
  { displayNameZh: '英属维尔京群岛', name: 'British Virgin Islands', countryCode: 'VGB', dialCode: '1284' },
  { displayNameZh: '约旦', name: 'Jordan', countryCode: 'JOR', dialCode: '962' },
  { displayNameZh: '越南', name: 'Vietnam', countryCode: 'VNM', dialCode: '84' },
  { displayNameZh: '赞比亚', name: 'Zambia', countryCode: 'ZMB', dialCode: '260' },
  { displayNameZh: '乍得', name: 'Chad', countryCode: 'TCD', dialCode: '235' },
  { displayNameZh: '智利', name: 'Chile', countryCode: 'CHL', dialCode: '56' },
  { displayNameZh: '中国大陆', name: 'China', countryCode: 'CHN', dialCode: '86' },
  { displayNameZh: '瑙鲁', name: 'Nauru', countryCode: 'NRU', dialCode: '674' },
  { displayNameZh: '斐济', name: 'Fiji', countryCode: 'FJI', dialCode: '679' },
] as const;

/**
 * 按 countryCode (ISO alpha-3) 快速查找店面信息
 * @example STOREFRONT_BY_CODE.get('USA') => { displayNameZh: '美国', name: 'United States', ... }
 */
export const STOREFRONT_BY_CODE: ReadonlyMap<string, AppleStorefront> = new Map(
  APPLE_STOREFRONTS.map((sf) => [sf.countryCode, sf]),
);

/**
 * 按英文名快速查找店面信息
 * @example STOREFRONT_BY_NAME.get('China') => { displayNameZh: '中国大陆', countryCode: 'CHN', ... }
 */
export const STOREFRONT_BY_NAME: ReadonlyMap<string, AppleStorefront> = new Map(
  APPLE_STOREFRONTS.map((sf) => [sf.name, sf]),
);

/**
 * 美国默认店面信息 (Apple 默认返回的 defaultStorefront)
 * @remarks storefrontId = '143441-19,8'
 */
export const DEFAULT_STOREFRONT = {
  countryCode: 'USA',
  name: 'United States',
  displayNameZh: '美国',
  dialCode: '1',
  storefrontId: '143441-19,8',
} as const;

/**
 * ISO alpha-3 countryCode → Apple Store URL 路径段 (小写两字母) 映射.
 *
 * 仅包含高频/已验证可用的国家/地区.
 * 用于:
 * 1. 将 storefront countryCode 转换为余额查询的 region 路径
 * 2. 作为登录阶段 session 预热的目标列表
 *
 * @example COUNTRY_CODE_TO_REGION['JPN'] → 'jp'
 */
export const COUNTRY_CODE_TO_REGION: Readonly<Record<string, string>> = {
  USA: 'us', JPN: 'jp', CHN: 'cn', KOR: 'kr', SGP: 'sg', GBR: 'uk',
  HKG: 'hk', TWN: 'tw', MAC: 'mo', AUS: 'au', CAN: 'ca', DEU: 'de',
  FRA: 'fr', ITA: 'it', ESP: 'es', BRA: 'br', MEX: 'mx', RUS: 'ru',
  IND: 'in', IDN: 'id', THA: 'th', VNM: 'vn', MYS: 'my', PHL: 'ph',
  NZL: 'nz', NLD: 'nl', BEL: 'be', SWE: 'se', NOR: 'no', DNK: 'dk',
  FIN: 'fi', POL: 'pl', CHE: 'ch', AUT: 'at', IRL: 'ie', PRT: 'pt',
  GRC: 'gr', TUR: 'tr', SAU: 'sa', ARE: 'ae', EGY: 'eg', ZAF: 'za',
  NGA: 'ng', COL: 'co', ARG: 'ar', CHL: 'cl', PER: 'pe', ISR: 'il',
};

/**
 * @description 将 ISO alpha-3 countryCode 转为 Apple Store URL region 路径.
 *
 * 优先使用 COUNTRY_CODE_TO_REGION 映射, 回退到取前两个字母小写.
 *
 * @param countryCode ISO alpha-3 代码 (如 'JPN')
 * @returns region 路径 (如 '/jp')
 */
export function toRegionPath(countryCode: string): string {
  const code = COUNTRY_CODE_TO_REGION[countryCode] || countryCode.substring(0, 2).toLowerCase();
  return `/${code}`;
}

/**
 * 高频国家/地区的 region 路径列表 — 登录阶段 session 预热目标.
 *
 * ⚠️ 顺序即优先级: 账号不足时按此顺序截断, 靠前的地区优先预热.
 * 手动维护而非 Object.values() 自动生成, 因为:
 * 1. Object.values() 的遍历顺序虽在 V8 中按插入序, 但语义上不表达优先级
 * 2. new Set() 展开后的顺序在不同运行时可能不一致
 * 3. 显式数组使优先级意图一目了然, 便于调整
 *
 * @example ['/us', '/jp', '/cn', '/kr', ...]
 */
/**
 * region 路径 → 中文地区名 反向查找表.
 *
 * 由 COUNTRY_CODE_TO_REGION 和 STOREFRONT_BY_CODE 构建:
 *   '/us' → 'USA' → STOREFRONT_BY_CODE.get('USA').displayNameZh → '美国'
 *
 * 用于将查询结果中的 region path 转为用户友好的中文名存储到数据库.
 *
 * @example REGION_TO_DISPLAY_NAME_ZH.get('/us') → '美国'
 * @example REGION_TO_DISPLAY_NAME_ZH.get('/jp') → '日本'
 */
export const REGION_TO_DISPLAY_NAME_ZH: ReadonlyMap<string, string> = new Map(
  Object.entries(COUNTRY_CODE_TO_REGION)
    .map(([code, region]) => {
      const sf = STOREFRONT_BY_CODE.get(code);
      return sf ? [`/${region}`, sf.displayNameZh] as [string, string] : null;
    })
    .filter((entry): entry is [string, string] => entry !== null),
);

export const HIGH_FREQUENCY_REGION_PATHS: readonly string[] = [
  '/us', '/jp', '/cn', '/kr', '/sg', '/uk',
  '/hk', '/tw', '/mo', '/au', '/ca', '/de',
  '/fr', '/it', '/es', '/br', '/mx', '/ru',
  '/in', '/id', '/th', '/vn', '/my', '/ph',
  '/nz', '/nl', '/be', '/se', '/no', '/dk',
  '/fi', '/pl', '/ch', '/at', '/ie', '/pt',
  '/gr', '/tr', '/sa', '/ae', '/eg', '/za',
  '/ng', '/co', '/ar', '/cl', '/pe', '/il',
];
