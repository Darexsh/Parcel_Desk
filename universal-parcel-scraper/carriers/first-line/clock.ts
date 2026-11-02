/** Beijing's clock, on which FIRST LINE dates its rows in China and Hong Kong. */
export const FIRST_LINE_CHINA_ZONE = 'Asia/Shanghai';

// Latin names of the line's Chinese leg, as its rows and aggregators' copies write them
// ("SHENZHEN", "HK international airport", "SZ international airport").
const CHINA_LEG = /^(?:shenzhen|guangzhou|dongguan|hong\s*kong|hk|sz)(?![a-z])/i;

/**
 * Whether a FIRST LINE row was scanned in China or Hong Kong: its place is
 * written in Chinese or starts with a city of the line's Chinese leg.
 */
export function firstLineInChina(location: string): boolean {
  return /\p{Script=Han}/u.test(location) || CHINA_LEG.test(location.trim());
}
