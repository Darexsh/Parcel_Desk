# RAM Hand-to-Hand Couriers

RAM is a South African courier for high-value and secure deliveries. International shipments
travel on DHL Express waybills, which belong to DHL. Tracked through the lookup its tracking page
makes.

## How it works

1. `direct`: one `GET https://www.ram.co.za/api/track/{number}`, as the tracking page at
   `ram.co.za/track/{number}` makes it once it has loaded. It needs no cookie, token, key or
   browser. The JSON reply has the waybill, the sender's reference and the scans grouped under
   their day, oldest first.

- An unknown number is HTTP 200 with a single `NO TRACKING FOUND` line, which the page reports
  as not found. The line carries the lookup's own day and time, or none for a short number. A
  404 or a redirect is a moved route.
- The reply must echo the number asked. The lookup gives it back in capitals.
- Recognition makes the same request.

## Notes

- A scan's time is a wall clock to the minute under its day's heading, such as `23 March 2022`.
  The reply names no zone, so clocks stay `local_time`.
- The tracker writes each scan as one line, such as `OUT FOR DELIVERY IN Isando, Johannesburg`.
  The place after `IN` becomes the location and the wording keeps `OUT FOR DELIVERY`, so the
  wording does not change with the branch. A road leg names both ends: the end where the scan
  happened becomes the location and the other stays in the wording. `Client Site`, RAM's word
  for the sender's premises, names no place and is no location.
- The page shows a run of the same line on one day once, at its last time: one line per parcel
  of the waybill. The adapter does the same.
- A line keeps one detail after ` - `, such as a failed delivery's reason or a call's subject, in
  words only. Delivery lines lose `RECEIVED BY` and the receiver's name. The notes call-centre
  staff type after a call's subject, which can hold the recipient's address, and the sender's
  reference are not kept.
- Text, e-mail and call records and the proof of delivery filed after a delivery move nothing.
- The page's two-part path, `/track/{account}/{reference}`, first turns a sender's reference into
  a waybill through `/api/track/resolve/`. The adapter reads the waybill alone.

## Limitations

- No service, weight, delivery estimate or delivery time as an instant.
- No reply read names a DHL Express waybill, so there is no hand-off.
- The Advanced Online Tracking the page offers account holders needs a login and is not read.

## Numbers

Waybills are `RAM` followed by eight digits. Shorter references of one or a few letters followed
by six or seven digits also have histories on the tracker. Rule `ram-hand-to-hand-1` suggests RAM
for the `RAM` waybills at low confidence, since none of them has been seen with a history, and
recognition asks the tracker about them. A letter followed by seven digits is also a GLS layout,
and the other references are too generic to point to RAM, so no rule claims them.

The adapter takes six to thirty letters and digits, at least one a digit: the lookup answers for
anything, and cuts the number it echoes to thirty characters. The samples and their sources are
in [`numbers.json`](numbers.json).

## Links

RAM's tracker reads the number from the path, as in `ram.co.za/track/<number>`; older addresses
use `/Track/`.

## Testing

`npm run test:carriers:live -- carriers/ram-hand-to-hand`, with
`RAM_HAND_TO_HAND_TRACKING_NUMBER` and optionally `RAM_HAND_TO_HAND_UNKNOWN_NUMBER` set outside
the repository.
