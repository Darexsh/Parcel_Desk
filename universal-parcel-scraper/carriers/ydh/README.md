# YDH

YDH is 义达跨境 (YDH Cross border (Shanghai) Logistics), a Shanghai forwarder that began with a
line from China to Japan and now runs direct parcel lines to Japan, the United States and Europe.
Its site is ydhex.com. The adapter reads its tracker's own lookup.

## Numbers

YDH's numbers are `YDH`, ten digits and two letters, `YQ` or `AZ` so far. Three public examples
are answered by YDH's own tracker, so `ydh-1` has high confidence. The partner that delivers a
parcel abroad gives it its own number, which the tracker shows beside YDH's.

## How it works

1. `direct`: the tracker at track.ydhex.com runs on the rtb56 forwarder platform, whose
   `GET /webservice/Service.ashx` lookup answers without a cookie, key or CAPTCHA. The adapter
   sends the request [YYpost's](../yypost/README.md) does, through the module the platform's
   adapters share, and reads the JSONP reply in its callback or bare.
2. `retry`: one more read when the first fails to connect or hangs. The first gets half of the
   budget.

- Only the entry whose `server_hawbcode` is the whole number asked is read.
- The tracker's unknown-number answer is a not-found. Its "Parameter error" is a schema
  failure and any other refusal is inconclusive. Redirects, 404s and browser checks are never
  read as a missing parcel.

## Notes

- Scans keep their wall clocks, in the tracker's order. Their `time_zone` is not read: scans in
  the United States are all labelled GMT-08:00 whatever the place and season, and so are
  Chinese warehouse scans on such a parcel.
- YDH files its milestones and its partner's with a code, whatever the wording: YDH's own in
  Chinese or English, the partner's relayed in its language. A scan is staged by its code,
  else by the wording recorded in [statuses.json](statuses.json), then the shared rules. DD
  covers a delivery the partner could not make or put off, so its wording decides.
- A partner's feed can repeat one of YDH's own scans without its code or English wording, at
  the same clock. That copy is dropped.
- A label or electronic information recorded after the parcel moved is no step back.
- `channel_hawbcode`, the partner's number, becomes `delivery_tracking_number`, and the
  hand-off decides who is asked. The partner's name is not read: it can be a reseller rather
  than the network that delivers.
- The merchant's order reference and the signatory are not read.

## Limitations

No ETA, weight, service, instant with a zone or proof of delivery.

## Links

The tracker's `track_query.aspx?track_number=` opens one number.

## Testing

`npm run test:carriers:live -- carriers/ydh`, with `YDH_TRACKING_NUMBER` and optionally
`YDH_UNKNOWN_NUMBER` set outside the repository.
