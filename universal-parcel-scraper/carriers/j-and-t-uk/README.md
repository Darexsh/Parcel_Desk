# J&T Express UK

J&T Express UK runs its own delivery network, site and tracker. Tracked through the lookup its
tracking page makes, on the same J&T platform as `j-and-t-au`, whose
[shared module](../j-and-t-au/official.ts) makes the request and reads the reply.

## How it works

1. `direct`: one `POST https://official.jtexpress.uk/official/logisticsTracking/getDetailByWaybillNo`
   with the body `{"waybillNos":["{number}"],"langType":"EN"}` and the page's `langType`,
   `appId`, `timestamp`, `nonce`, `country` (`EN`), `key`, `sign` and `timezone` headers. It
   needs no cookie, account, postcode, CAPTCHA or browser. The JSON reply has one answer per
   waybill it knows, which names the waybill in `keyword` and lists its scans in `details`.
2. `retry`: the same lookup once more after a request that does not reach the site or times out.

- The app id, key and signature are J&T Express Australia's; see its README. A refused
  signature or parameters are schema failures, not unknown waybills.
- An unknown waybill is HTTP 200 with code 1 and an empty `data`, which the page reports as
  having no tracking records: not found. A found waybill without scans has no history.
- Recognition makes the same request.

## Notes

- The page shows each scan's `scanTime` and sentence (`customerTracking`). The reply adds a scan
  type code and a Chinese scan type and status, which the page does not show; the adapter reads
  the sentence. The map in `statuses.json` stages the sentences seen live; other sentences fall
  to the shared wording rules.
- The courier's collection for the delivery round ("collected and is on its way") is out for
  delivery: the reply files it as a delivery scan. An incomplete address on the same day is a
  failed attempt.
- The reply writes `scanTime` in the zone the request names in `timezone`: the same scans come
  back eight hours later for `GMT+0800`. The adapter names `GMT+0000`, so each scan time is an
  instant in UTC, in British Summer Time as in winter.
- The page's postcode check before showing a delivery photo is not called.

## Limitations

- No place, ETA or weight.
- A sentence neither the map nor the wording rules know has no stage.
- A history longer than 100 scans keeps the newest 100.

## Numbers

Its waybills are `JTUK` and twelve digits, `JT` and the country code, the layout of J&T's
Australian and German waybills. Its tracker answers for them and no other carrier's rule takes the
shape, so `j-and-t-uk-1` has high confidence.

## Links

The [tracker](https://www.jtexpress.uk/tracking) looks a parcel up when the number is in its `q`
parameter. Such a link names J&T Express UK only for one of its own numbers, `JTUK…`;
another number in it is left to detection.

## Testing

`npm run test:carriers:live -- carriers/j-and-t-uk`, with `J_AND_T_UK_TRACKING_NUMBER` and
optionally `J_AND_T_UK_UNKNOWN_NUMBER` set outside the repository.
