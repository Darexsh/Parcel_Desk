# Jifan

Jifan is 吉凡国际物流 (深圳市吉凡国际物流有限公司, Shenzhen Jifan International Logistics), a
Shenzhen cross-border forwarder whose site is szjf56.cn. Universal providers name it Jifan.
Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.szjf56.cn/index/tracknumber/getTrackingByNos?nos={number}`,
   as the tracking page's script sends it on load. It needs no cookie, key, CAPTCHA or browser.
2. `retry`: one more request after a network failure or a timeout. The first gets half of the
   budget.

- The tracker is [CTTYEX's](../cttyex/README.md) system, and the adapter reads its reply with
  CTTYEX's parser: a JSON array, served as HTML, with an item per number asked, holding the
  summary's status and the countries in Chinese and the scans in English, newest first. The item
  must echo the whole number in capitals.
- An unknown number, or one the tracker no longer keeps, is HTTP 200 with the status "查询不到"
  and no scans. Only that answer is not found.
- A redirect or a 404 is a moved route. A browser check in place of the reply is a challenge, and
  any other reply that is not the expected JSON is a schema failure.

## Notes

- The scans are worded as on CTTYEX's tracker: Jifan's steps in China, from the order data to the
  flight out, then the destination agent's and the last-mile network's. They are staged by
  CTTYEX's map; others go through the shared wording rules. Every row is a wall clock on Beijing
  time, abroad too. A row abroad can open with a town, state and ZIP code: the town and state
  become the location and the ZIP code is dropped.
- The destination's Chinese name becomes a country code where it names a country.

## Limitations

- No location for Jifan's steps in China, and no delivery estimate, weight, delivery partner or
  partner number.

## Numbers

Its numbers are `JFGJ`, the company's initials, nine digits and `CN`. A lookup on Jifan's own
tracker, archived by the Wayback Machine, shows a parcel's history under such a number, and no other
carrier's rule takes the layout, so `jifan-1` has high confidence. The archived number's ninth digit
is the S10 check digit of the eight before it, but a parcel a universal provider files under Jifan
fails that check, so the rule checks no digit.

## Links

`www.szjf56.cn/index/tracknumber/track?nos={number}` opens one parcel on the tracker, which looks
the number up on load. The page takes any number, so the link names Jifan only for one in its
layout.

## Testing

`npm run test:carriers:live -- carriers/jifan`, with `JIFAN_TRACKING_NUMBER` and optionally
`JIFAN_UNKNOWN_NUMBER` set outside the repository.
