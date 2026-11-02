# YYpost

YYpost (远邮, Shenzhen Yuanyou International Logistics) is a Shenzhen forwarder that flies
parcels through Hong Kong and hands them to a network in the destination country. Its tracker is
on yypostal.com. The adapter reads the tracker's own lookup for numbers of YY, nine digits and
CN.

## How it works

1. `direct`: the tracking page asks YYpost's tenant of the rtb56 tracking platform, `GET
   http://szyy.rtb56.com/webservice/Service.ashx`, without a cookie or account, and the
   adapter sends the same request: `method=track`, `param` set to `{"sp":"","nums":[…]}` and
   `key` set to the Base64 of that text's MD5 in hexadecimal, as JSONP (`callbackparam`). It
   reads the reply in that callback, or bare. The platform's host answers plain HTTP only: its
   certificate is not for that name. DayOne's and Intel-Valley's trackers run on the same
   platform, and [rtb56.ts](rtb56.ts) holds what the three adapters share.
2. `retry`: one more read when the first fails to connect or hangs. The first gets half of the
   budget.

## Notes

- Only the entry whose `server_hawbcode` is the whole number asked is read.
- Scans are wall clocks without a zone: the reply's `time_zone` and `utc_offset` are empty, and
  the rows at the destination's airport are as likely on its clock as on China's. YYpost's scans
  keep their wall clocks, in the tracker's order, and their places date them.
- A row without a scan code or a place is the onward network's, on that network's clock. When
  the onward number is Ecoscooting's, such a row is dated on Spain's clock: so read, its
  shipment order falls to the second of Ecoscooting's own record of it, while China's clock,
  which the row's neighbours would give it, puts it hours earlier.
- Scans are English wording from YYpost's warehouse in Shenzhen, its air line through Hong Kong
  and the destination's clearance, staged by the wording recorded in
  [statuses.json](statuses.json), then the shared rules. Scan codes only mark a row as
  YYpost's, and the parcel's summary status, which repeats the newest scan's, is not read. The
  onward network's shipment order, recorded after the parcel has left the warehouse, is no step
  back.
- `channel_hawbcode`, the onward network's number, becomes `delivery_tracking_number`, and the
  hand-off decides who is asked: for a Portuguese `CNPRT` number, Cainiao's last mile there.
- The tracker's unknown-number answer is a not-found. Its "Parameter error" is a schema
  failure and any other refusal is inconclusive. Redirects, 404s and browser checks are never
  read as a missing parcel.
- The merchant's order reference, the signatory and the proof-of-delivery link are not read.

## Numbers

YYpost's numbers have S10's layout and check digit with CN. The S10 standard leaves the Y
series unassigned, YYpost's tracker answers these numbers and China Post's has no record of
them, so `yypost-1` names YYpost for YY, nine digits and CN with a valid check digit, and
China Post's CN rule leaves them out. YY with another country code stays with that country's
post.

## Links

The tracking page opens a parcel at `http://www.yypostal.com/track.html?c=` and the number.
It is plain HTTP, so no portal link is published.

## Testing

Set `YYPOST_TRACKING_NUMBER` and optionally `YYPOST_UNKNOWN_NUMBER` outside the repository, then
run `npm run test:carriers:live -- carriers/yypost`.
