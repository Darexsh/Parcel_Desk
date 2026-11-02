import { canadaProvinceTimeZone, countryCode, usStateTimeZone } from '../../core/time/index.js';

// Beijing time, the one clock of mainland China.
const CHINA_ZONE = 'Asia/Shanghai';
// Provinces, regions and municipalities of mainland China and its larger cities, in pinyin.
const CHINA_NAMES = [
  'Anhui', 'Beijing', 'Chongqing', 'Fujian', 'Gansu', 'Guangdong', 'Guangxi', 'Guizhou', 'Hainan', 'Hebei', 'Heilongjiang',
  'Henan', 'Hubei', 'Hunan', 'Inner Mongolia', 'Jiangsu', 'Jiangxi', 'Jilin', 'Liaoning', 'Ningxia', 'Qinghai', 'Shaanxi',
  'Shandong', 'Shanghai', 'Shanxi', 'Sichuan', 'Tianjin', 'Tibet', 'Xinjiang', 'Xizang', 'Yunnan', 'Zhejiang',
  'Changchun', 'Changsha', 'Changzhou', 'Chengdu', 'Dalian', 'Dongguan', 'Foshan', 'Fuzhou', 'Guangzhou', 'Guiyang',
  'Hangzhou', 'Harbin', 'Hefei', 'Huizhou', 'Jinan', 'Jinhua', 'Kunming', 'Kunshan', 'Lanzhou', 'Nanchang', 'Nanjing',
  'Nanning', 'Ningbo', 'Qingdao', 'Quanzhou', 'Shantou', 'Shenyang', 'Shenzhen', 'Shijiazhuang', 'Suzhou', 'Taiyuan',
  'Urumqi', 'Wenzhou', 'Wuhan', 'Wuxi', "Xi'?an", 'Xiamen', 'Yiwu', 'Zhengzhou', 'Zhongshan', 'Zhuhai',
];
// A label opening with a region of China, as "South China Transit Center", or with one of those names.
const CHINA_PLACE = new RegExp(`^(?:(?:north|south|east|west|central|north-?east|north-?west|south-?east|south-?west)\\s+china|${
  CHINA_NAMES.join('|')})(?![a-z'])`, 'i');
// A place written in Chinese, as a warehouse's "安徽总仓库-操作中心", with no Japanese kana or Korean
// script; Hong Kong, Macau and Taiwan written so are no mainland China.
const CHINESE_SCRIPT = /^(?=.*\p{Script=Han})(?!.*[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])(?!.*(?:香港|澳[门門]|台[湾灣]|臺灣))/u;
// A flight's departure, take-off or landing.
const FLIGHT = /\b(?:flights?|landing|landed|take-?off|uplifted)\b/i;

/**
 * Whether a row's place lies in mainland China: its first part is the
 * country, or it opens with a region, province or city of China, or it is
 * written in Chinese. A town of a US state or a Canadian province, as
 * "China, ME", does not.
 */
function inChina(place: string): boolean {
  const [first = '', ...rest] = place.split(',').map((part) => part.trim());
  if (rest.some((part) => usStateTimeZone(part) || canadaProvinceTimeZone(part))) return false;
  return countryCode(first) === 'CN' || CHINA_PLACE.test(first) || CHINESE_SCRIPT.test(place);
}

/**
 * The clock of a JS Express row at a place in mainland China: Beijing time,
 * for JS Express's and its line's warehouse, sorting and export rows alike,
 * and null for a flight's departure filed there, which keeps its wall clock.
 * Undefined for a row elsewhere or without a place.
 */
export function jsExpressChinaClock(description: string, location: string): string | null | undefined {
  if (!location || !inChina(location)) return undefined;
  return FLIGHT.test(description) ? null : CHINA_ZONE;
}
