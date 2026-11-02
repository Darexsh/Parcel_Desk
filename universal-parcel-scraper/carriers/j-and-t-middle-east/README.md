# J&T Express Middle East

J&T Express Middle East is J&T's operation in Saudi Arabia, the United Arab Emirates and Kuwait,
with its own network, site and tracker apart from the other J&T operations. Tracked through the
lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://cms.jtexpress.com/overseas/captcha/captcha-switch.json`, then one
   `POST https://ofmg.jtjms-sa.com/official/logisticsTracking/v2/getDetailByWaybillNo` with the
   body `{"waybillNo":["{number}"],"langType":"EN","ticket":"captcha-close","randstr":"captcha-close"}`
   and the page's `langType`, `timezone` and `countryId` headers. It needs no cookie, token,
   key or browser. The JSON reply has one answer, which names the waybill in `keyword` and lists
   its scans in `details`, newest first.
2. `retry`: the same lookup once more after a request that does not reach the site or times out.

- The page's captcha script, `captchaV1.js`, reads the switch before each lookup. Only
  `{"enabled": false}` turns the captcha off, and a switch the script cannot read counts as
  off; then it hands the lookup `captcha-close` as ticket and random string. The adapter reads
  the switch the same way and keeps its reading for five minutes. While the switch is on it
  reports a challenge without a lookup. A reply with code 1350200260, the page's cue to show
  the captcha, is a challenge too.
- An unknown waybill is HTTP 200 with code 135020020, which the page reports as not found. A
  found waybill without scans, which the page says it cannot track, has no history. A 404 or
  a redirect is a moved route, and a page in place of JSON is a challenge.
- Codes 999001010 and 999001030 refuse the request's parameters. They are schema failures, not
  unknown waybills.
- The answer's `keyword` must be the waybill asked, as must any waybill a scan names.

## Notes

- A scan's description is the label the page heads it with, such as `Order creation`, and its
  `statusCode` is the provider code. The page reads the code only to pick an icon, so the
  label stages the scan: through the map in `status.ts`, else the shared wording rules.
- A scan's location is its branch's town and province. The sentence under each label
  (`customerTracking`) is free text with, as in J&T's other trackers, the courier's name and
  phone. It is not read, nor are the fields for the courier, the signer and the branch's
  contact, or the delivery pictures.
- The tracker gives each `scanTime` in the zone the request's `timezone` names, the page's
  visitor's, without an offset: the same scan reads an hour later for `GMT+0400` than for
  `GMT+0300`. The adapter asks for Saudi Arabia's `GMT+0300` and reads every scan as an
  instant at `+03:00`, a scan in the UAE included. None of the three countries has daylight
  saving.
- `GET /official/waybillOrder/getDetailByNo` on the same host has the sender's and receiver's
  towns. The adapter makes no second request.

## Limitations

- No ETA or weight.
- A scan in the UAE has its instant at `+03:00`, not at the UAE's own `+04:00`.
- A label neither the map nor the wording rules know has no stage.
- While J&T's captcha switch is on, every lookup is a challenge.
- A history longer than 100 scans keeps the newest 100.

## Numbers

J&T Express Middle East runs one network, site and tracker for Saudi Arabia, the United Arab
Emirates and Kuwait. Its tracking form accepts a waybill only as `JTE` followed by twelve
digits, and its tracker answers such numbers for all three countries. `j-and-t-middle-east-1`
claims that shape.

## Links

The tracker opens one or more waybills at `www.jtexpress.me/<country>/trajectoryList` from
`waybillNo`, where the country is `KSA`, `UAE` or `KW`; `www.jtexpress.ae` serves the same site.

## Testing

`npm run test:carriers:live -- carriers/j-and-t-middle-east`, with
`J_AND_T_MIDDLE_EAST_TRACKING_NUMBER` and optionally `J_AND_T_MIDDLE_EAST_UNKNOWN_NUMBER` set
outside the repository.
