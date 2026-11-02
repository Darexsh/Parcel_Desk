# Gokulam Speed & Safe

Gokulam Speed & Safe is a courier network in Kerala, India. Tracked through the ERP lookup its
tracking page's script makes.

## How it works

1. `direct`: one `GET https://erp.gokulamspeedandsafe.com/online/getconsignmentstatus?consignmentno={number}`,
   as the tracking page's script sends it. It needs no cookie, token, key or browser. The JSON
   reply lists the consignment's scans, newest first.
2. `retry`: a request that fails to reach the ERP, or hangs, is sent once more within the
   budget.

- An unknown number is HTTP 200 with `statusCode` "200" and no rows, which is not found. The
  page words another `statusCode` as an invalid number, but an unknown number never gets one, so
  the adapter reads it as inconclusive.
- Every row's `consignmentno` is the route, then the number, as `Origin-Destination( Area )-{number}`.
  Each row must end with the number asked.
- Sucuri's firewall sits in front of the ERP. A firewall page in place of the reply, or a 403,
  is a challenge. A redirect or a 404 is a moved route, and a reply that is not the expected JSON
  is a schema failure.

## Notes

- Each scan's `processdate` is the ERP's timestamp with its offset, India's +05:30, so scans keep
  that instant to the second. No clock is read in a zone.
- Each row has a one-letter `transit` code, kept as the provider code: `M` for a dispatch, `I`
  for an arrival, `O` for out for delivery and `D` for a delivery. The status wording stages it.
- A dispatch goes from `source` to `dest` and an arrival is at `dest`. As the page does, their
  wording names that other branch, as `Dispatched to …` and `Arrived at …`. A scan's place is
  the branch it was made at: an arrival's `dest`, else its `source`. The `dest` of an
  out-for-delivery or delivery row is the delivery's area, which is not kept.
- A status ends with a dash, as `Arrived- `. What the ERP writes after the dash is not kept.
- The page's second call, for the consignee's name, is not made. The branch's phone and the
  row's remarks are not kept.

## Limitations

- No expected delivery, booking time, origin, destination, weight or sender.

## Numbers

The tracker takes AWB numbers. A complaint gives an eight-digit number, and the adapter takes
eight digits; the page itself only asks for three characters or more. Eight-digit runs are
printed by many other carriers, so no rule claims them, preflight does not ask Gokulam Speed &
Safe, and a number reaches the adapter when the user or a provider names the carrier.

## Links

The tracking page looks the number up by script and does not read it from its address, so no
address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/speed-and-safe`, with `SPEED_AND_SAFE_TRACKING_NUMBER`
and optionally `SPEED_AND_SAFE_UNKNOWN_NUMBER` set outside the repository.
