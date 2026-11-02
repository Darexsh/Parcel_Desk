# Tonami Transportation

Tonami Transportation (トナミ運輸) is a major Japanese less-than-truckload carrier based in Toyama.
Its site is tonami.co.jp.

## How it works

1. `direct`: one `GET https://trc1.tonami.co.jp/trc/search3/excSearch3?id[0]={number}`, the page
   its tracker's form opens. It needs no cookie, token or browser.
2. `retry`: the request once more when it fails to reach the tracker or hangs. The first try
   gets half of the budget, so the retry fits in the rest.

- The page lists the number asked with its current state, and details the shipment below. A
  number the tracker does not hold, or no longer holds, gets `該当伝票番号なし` in its list row
  and no detail, read as not found. A redirect or a 404 is a moved route, a firewall page is a
  challenge and a 429 is a rate limit.
- The detail must carry the whole number asked.
- Recognition makes the same request.

## Notes

- The history is a fixed list of milestones, from the intake (`荷受`) to the delivery (`配完`); a
  milestone the parcel has not reached, or skipped, has no day and is left out. Each row has a day
  without a year, and the delivery row also has its minute. The year is the latest that does not
  put the day after the day following the lookup in Japan; the tracker keeps about three months.
  Days stay `local_time`, and the delivery minute is read in Japan's zone.
- Newest first: a later day goes first, and rows of one day keep the tracker's order, reversed.
- The detail's current state is the result's status when the map lists it; otherwise the newest
  milestone gives the stage.
- A parcel handed to a partner carrier shows the partner's branch on the later rows and the
  partner's number in the detail; the partner's number is not kept. The branches' phone numbers
  and towns, the parcel count and the volume are not read either.

## Limitations

- No expected delivery, no codes and no clock before the delivery.

## Numbers

Its inquiry numbers are ten digits with a mod-7 check digit, a layout other Japanese carriers'
numbers and several rules share, so there is no rule. The adapter takes only numbers whose check
digit matches.

## Links

The tracker opens a number from its `id[0]` parameter.

## Testing

`npm run test:carriers:live -- carriers/tonami`, with `TONAMI_TRACKING_NUMBER` and optionally
`TONAMI_UNKNOWN_NUMBER` set outside the repository.
