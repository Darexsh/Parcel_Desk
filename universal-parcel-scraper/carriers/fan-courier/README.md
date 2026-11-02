# FAN Courier

Romanian FAN Courier parcels, FANbox ones included, through the anonymous lookup of FAN
Courier's own AWB tracker.

## How it works

1. `direct`: a POST of the form the tracking page sends, `action=get_awb`, the AWB and
   `lang=en-US`, to `https://www.fancourier.ro/limit-tracking.php`. The JSON reply carries
   every event with its code, wording, town and wall clock. No cookie, nonce, account or
   CAPTCHA is needed: the page loads reCAPTCHA keys, but its tracking lookup sends no
   token.

## Numbers

Every AWB found has thirteen digits: in FAN Courier's API 2.0 documentation, in an
open-source client, in lookups archived from its tracker and in the tracker's own replies.
They start with `2`, `4` or `7000`, but FAN publishes no length, prefix or check-digit rule.
Thirteen digits are shared with several posts and couriers, so a low-confidence rule offers
FAN Courier for those starts alongside them, and recognition asks it first for a parcel from
Romania. No other carrier's sample starts with `70`, so `fan-courier-2` puts FAN Courier first
for the `7000` series wherever the parcel comes from. The adapter refuses any other shape
without a request.

## Notes

- The reply must name the requested AWB in `awbNumber`. An unknown AWB comes back without
  one, with the requested number in `content` and the tracker's "not found" message, in
  English or Romanian; only that reply is not found. Another message, an AWB without events,
  an empty reply, a rejected request or a missing page is inconclusive, and a Cloudflare page
  is a challenge.
- Events are mapped by code in [status.ts](status.ts). The codes and their names come from
  the event list in FAN Courier's API documentation; S56 (handed in at a FANbox or collect
  point) and S65 (held for the next transport abroad) are named only by the tracking page's
  own code. S46, handed over on a delivery point, waits for collection: the documentation names
  FANbox lockers, PayPoints and offices delivery points. Codes whose meaning no source settles,
  such as S49, keep no stage.
- A refusal or a return is an exception, not a return to the sender: the return travels under
  an AWB of its own, which the page shows and the adapter does not follow.
- The page hides the events after the last delivery, and so does the adapter.
- Clocks carry no offset and stay local wall times, read in the catalog zone.
- The contents, weight, dimensions, payment date, related AWBs and the masked name of the
  person who signed are never read.
- Recognition asks the tracker and knows an AWB when it returns events.

## Links

FAN Courier's tracker writes the AWB into its address as `?tracking={number}` and renders
that number back when the page loads, on `/awb-tracking/` and on the English `/en/awb-track/`.
Older links put the AWB in `awb` or in the path.

## Limitations

Reference searches, which the page also accepts, are not supported. The reply has no
estimate, sender or pickup point.

## Testing

```sh
FAN_COURIER_TRACKING_NUMBER=... FAN_COURIER_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/fan-courier
```
