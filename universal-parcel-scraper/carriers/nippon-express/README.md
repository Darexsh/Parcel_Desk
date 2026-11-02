# Nippon Express

Nippon Express (日本通運, NX) is a Japanese logistics group. This entry covers its domestic air
courier, which its air tracker (航空便の配達状況確認) follows. Tracked through that tracker's list
page.

## How it works

1. `direct`: one `GET https://lp-trace.nittsu.co.jp/web/webarpaa702.srv?LANG=JP&denpyoNo1={number}`,
   the list the tracker's search form opens. It needs no cookie, token, key or browser. The
   page is Windows-31J.
2. `retry`: one more request after a network failure or a timeout.

- The list has one row per number asked. A number it holds a shipment for is linked to its
  detail page and has the latest status over its clock, the acceptance day, the delivery day the
  sender designated and the service. The row must name the whole number asked.
- An unknown number is HTTP 200 with a row saying the number does not exist and 該当データ無し,
  which is not found. 送り状番号違い, for a number that fails the tracker's check, is invalid
  input; any other reason is no answer.
- A firewall's block page, with HTTP 200 or 403, is a challenge. The page shown after a lost
  session, the search form, a redirect and a list without a row are no answer. A 404 is a moved
  page.
- Recognition makes the same request. Any row the list links for the number is known, also under
  a status the map does not stage.

## Notes

- The result is a summary: the latest status, its time and the service name (扱区分), with no
  scans. Fallback providers can fill in the history.
- The status clock has a month and a day without a year. The year is the latest one that puts
  the clock no later than the day after the lookup in Japan, read on Tokyo time.
- The acceptance day and the designated delivery day also come without a year, and nothing bounds
  them, so they are not kept.
- The detail page needs the list's session and a token from it, and adds the contents, the parcel
  count, the weight and the size. The adapter does not read it.
- The domestic small-parcel form on the group site posts the number to a separate service on
  `www20.nittsu.co.jp/sora/`, without a session. The adapter does not use it.

## Limitations

- A number the list shows more than once, for shipments that reused it, is no answer.
- A status [`status.ts`](status.ts) does not know stays without a stage.

## Numbers

The slip number (お問い合わせ伝票番号) has eleven, twelve or fourteen digits and is often printed
with hyphens. The tracker takes eight to fourteen digits whose last digit is the rest of the
others divided by seven or by nine, and the adapter applies the same check before a request.
The mod-7 check is the one Yamato, Sagawa and Japan Post use, so no rule claims these numbers.

## Links

`lp-trace.nittsu.co.jp/web/webarpaa702.srv` takes the number in `denpyoNo1` and lists its
status. The domestic small-parcel form on the group site posts the number instead.

## Testing

`npm run test:carriers:live -- carriers/nippon-express`, with `NIPPON_EXPRESS_TRACKING_NUMBER` and
optionally `NIPPON_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
