/** Beijing's clock, on which Huiyi Logistics dates its rows in China and Hong Kong. */
export const HYWL_CHINA_ZONE = 'Asia/Shanghai';

// Latin names of the line's Chinese leg, as its rows and 17TRACK's copies write them.
const CHINA_LEG = /^(?:shenzhen|guangzhou|dongguan|huizhou|hong\s*kong)(?![a-z])/i;

/**
 * Whether a Huiyi Logistics row was scanned in China or Hong Kong: its place is
 * written in Chinese ("深圳") or starts with a city of the line's Chinese leg
 * ("Shenzhen", "Hong Kong International Hub").
 */
export function hywlInChina(location: string): boolean {
  return /\p{Script=Han}/u.test(location) || CHINA_LEG.test(location.trim());
}
