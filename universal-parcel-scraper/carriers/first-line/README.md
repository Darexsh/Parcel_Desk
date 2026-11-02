# FIRST LINE

Tracks waybills of FIRST LINE (壹号专线, 深圳市壹号专线供应链有限公司), a Shenzhen forwarder of
the 1ST group (一代国际集团, 1st56.com), on its own tracker at firstline56.com. The group's
forwarders print 1ST waybills; the group's tracking page is offline and links to 17TRACK, and
FIRST LINE's tracker answers many of them.

## How it works

1. `direct`: one GET to `track.php`, which opens the session (`PHPSESSID` and `tokenc`
   cookies) and holds the lookup's address in its script, signed for that session
   (`query.php?meter=track_query&nonce=…&timestamp=…&sign=…`). Then one POST of
   `track_number=<number>` to that address with both cookies, as the page's script sends it.
2. `retry`: the same pair once more, in a new session, after a request fails to reach the
   tracker or hangs.

The tracker answers plain HTTP only. No account, key, CAPTCHA or browser is needed.

## Notes

- The reply is `ok{FGF}` and an HTML list: a header row with the number and its newest scan,
  then each scan as a clock, a place and the wording, six non-breaking spaces apart. A waybill
  the tracker does not know says 未找到此单号信息 instead. Another of the group's forwarders can
  hold it, so that answer is inconclusive, with the reason `portal_not_found`. A lookup without
  the session cookies, or with a spent signature, answers `error{FGF}` and 身份验证失败, which says
  nothing about the waybill.
- Scan times are wall clocks without an offset, each on its facility's clock: Shenzhen's, Hong
  Kong's, then the destination's, where the delivering partner's scans are relayed. Rows in
  China and Hong Kong, and the shipper's order data ("Forecast has been received"), which names
  no place, are dated on Beijing's clock: 17TRACK's copies have those instants to the second.
  The destination's rows stay wall clocks. Rows keep the tracker's order. A row is held back
  only when it is after the lookup on China's clock, the latest of them.
- The forwarder's own rows are mapped in [statuses.json](statuses.json); the delivering
  partner's, such as USPS's, go to the shared wording rules. ParcelsApp names the line "1ST"
  and relays its rows, which take the same map.
- The site answers a visitor sending many requests with HTTP 403 and 服务器繁忙 ("server busy"),
  which is read as rate limited.

## Limitations

The tracker names no delivery partner, last-mile number or destination country, and the
places' postcodes are dropped. It does not know every 1ST waybill: it answers 1ST06 waybills but not
1ST18 ones, which the providers that relay 1ST's rows track from the order data to the
delivery, in the English of another forwarder's system. No public tracker of the
group answers those: the group's own query at `1st56.com/group/tracking/` is gone (HTTP 404),
摆渡一下's tracker at ferryboatlogistics.com, the same software as FIRST LINE's without the
signature, does not know them, and 一代国际's at 1st168.com needs an account.

## Numbers

The group's waybills are 1ST and eleven digits. The prefix is the group's name and no other
carrier issues the layout, so the rule has high confidence. A number the tracker does not know
may belong to another of the group's forwarders.

## Links

The tracking page has no address that opens one waybill, and it is plain HTTP, so no portal
link is published.

## Testing

`npm run test:carriers:live -- carriers/first-line`, with `FIRST_LINE_TRACKING_NUMBER` and
optionally `FIRST_LINE_UNKNOWN_NUMBER` set outside the repository.
