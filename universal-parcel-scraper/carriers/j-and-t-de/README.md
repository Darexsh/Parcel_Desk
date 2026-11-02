# J&T Express Germany

J&T Express Germany runs its own delivery network, site and tracker. Tracked through the lookup its
tracking page makes, on the same J&T platform as `j-and-t-au`, whose
[shared module](../j-and-t-au/official.ts) makes the request and reads the reply.

## How it works

1. `direct`: one `POST https://official.jtexpress.eu/official/logisticsTracking/getDetailByWaybillNo`
   with the body `{"waybillNos":["{number}"],"langType":"EN"}` and the page's `langType`,
   `appId`, `timestamp`, `nonce`, `country` (`DE`), `key`, `sign` and `timezone` headers. It
   needs no cookie, account, postcode, CAPTCHA or browser. The JSON reply has one answer per
   waybill it knows, which names the waybill in `keyword` and lists its scans in `details`.
2. `retry`: the same lookup once more after a request that does not reach the site or times out.

- The app id, key and signature are J&T Express Australia's; see its README. A refused
  signature or parameters are schema failures, not unknown waybills.
- An unknown waybill is HTTP 200 with code 1 and an empty `data`, which the page reports as
  having no results: not found. A found waybill without scans has no history.
- Recognition makes the same request.

## Notes

- A scan is a `scanTime` and a sentence, with no status code or place. The map in
  `statuses.json` stages the English sentences seen live; other sentences fall to the shared
  wording rules. The van's loading, once for each delivery run, is out for delivery.
- The delivered scan names the delivery type in `【】` and ends with the customer service line.
  A delivery type the site offers its recipients, such as Left with neighbor, is kept out of
  brackets; anything else in brackets, the customer service line and phone numbers go.
- The reply writes `scanTime` in the zone the request names in `timezone`. The adapter names
  `GMT+0000`, so each scan time is an instant in UTC.
- The page's neighbour and postcode lookups, which show who took a parcel, are not called.

## Limitations

- No place, ETA or weight.
- A history longer than 100 scans keeps the newest 100.

## Numbers

Its waybills are `JTDE` and twelve digits, `JT` and the country code, the layout of J&T's
Australian waybills. Its tracker answers for them and no other carrier's rule takes the shape,
so `j-and-t-de-1` has high confidence.

## Links

The [tracker](https://www.jtexpress.de/tracking) looks a parcel up when the number is in its `q`
parameter. Such a link names J&T Express Germany only for one of its own numbers, `JTDE…`;
another number in it is left to detection.

## Testing

`npm run test:carriers:live -- carriers/j-and-t-de`, with `J_AND_T_DE_TRACKING_NUMBER` and
optionally `J_AND_T_DE_UNKNOWN_NUMBER` set outside the repository.
