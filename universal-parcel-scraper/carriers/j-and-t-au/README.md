# J&T Express Australia

J&T Express Australia runs its own network, site and tracker, apart from the Southeast Asian J&T
operations in `j-and-t`. Tracked through the lookup its tracking page makes. The pages of J&T
Express Germany and J&T Express UK make the same lookup on their own hosts, so
[official.ts](official.ts) holds the request and the reading of its reply for the three networks.

## How it works

1. `direct`: one `POST https://official.jtaunz.com/official/logisticsTracking/getDetailByWaybillNo?countryCode=AU`
   with the body `{"waybillNos":["{number}"],"langType":"EN"}` and the page's `langType`,
   `appId`, `timestamp`, `nonce`, `countryCode`, `key`, `sign` and `timezone` headers. It needs
   no cookie, account, phone digits, CAPTCHA or browser. The JSON reply has one answer per
   waybill it knows, which names the waybill in `keyword` and lists its scans in `details`.
2. `retry`: the same lookup once more after a request that does not reach the site or times out.

- `sign` is the MD5, in capitals, of the app id, the timestamp, the nonce, the body with its
  keys sorted and the key, as the page's script computes it. The app id and key are in that
  script, the same for every visitor. A refused signature (code 999001031) and refused
  parameters (999001010, 999001030) are schema failures, not unknown waybills.
- An unknown waybill is HTTP 200 with code 1 and an empty `data`, which the page reports as
  having no tracking records: not found. A found waybill without scans has no history. A 404
  or a redirect is a moved route, and a page in place of JSON is a challenge.
- The answer's `keyword`, and any waybill a scan names, must be the waybill asked.
- Recognition makes the same request.

## Notes

- A scan is a `scanTime` and a sentence (`customerTracking`), with no status code or place. The
  map in `status.ts` stages the sentences seen live, in English and in the Chinese the tracker
  answers other languages with; other sentences fall to the shared wording rules.
- The page marks text in `【】` and turns phone numbers into links. Sentences lose anything in
  brackets, the customer service number and the courtesy that offers it ("If you have any
  questions, please call …"), who signed for the parcel, a person named after their role and
  every phone number. A scan stored with the courtesy keeps its row.
- `scanTime` has no offset, but the reply writes it in the zone the request names in
  `timezone`, which the page sets to its visitor's, as `GMT+1100`. The adapter names
  `GMT+0000`, so each scan time is an instant in UTC wherever in Australia or New Zealand the
  scan was made.

## Limitations

- No place, ETA or weight.
- A sentence neither the map nor the wording rules know has no stage.
- A history longer than 100 scans keeps the newest 100.

## Numbers

Its waybills are `JTAU` and twelve digits, `JT` and the country code, and its tracker answers
for them. The shape is fixed and no other carrier's rule takes it, so `j-and-t-au-1` has high
confidence. No public number has been found, so the corpus holds a synthetic one.

## Links

The [tracker](https://www.jtexpress.au/tracking) looks a parcel up when the number is in its `q`
parameter. Such a link names J&T Express Australia only for one of its own numbers, `JTAU…`;
another number in it is left to detection.

## Testing

`npm run test:carriers:live -- carriers/j-and-t-au`, with `J_AND_T_AU_TRACKING_NUMBER` and
optionally `J_AND_T_AU_UNKNOWN_NUMBER` set outside the repository.
