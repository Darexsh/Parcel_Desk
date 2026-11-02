# Estes Forwarding Worldwide

Estes Forwarding Worldwide (EFW) is the Estes group's forwarding and home-delivery company:
air, ground and expedited freight, plus threshold and white-glove deliveries of large retail
items through its own terminals. It is separate from Estes Express Lines, the LTL carrier with
its own entry. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://efwtrack.com/api/ShipmentTracking/get_shipment_tracking` with
   the form body `TrackNo={number}&ConZip=NONE`, as the tracker at `efwtrack.com/track/{number}`
   sends it when its address has no ZIP code. It needs no cookie, token, key or browser. The
   JSON reply has EFW's contact details and a list of shipments, each with its service,
   scheduled delivery, freight lines and events.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An unknown number is HTTP 404 with the message `This Tracking Number was not found in the
  ShipTrack database.`, which the page reports as not found. Another 404 or a redirect is a
  moved route.
- The tracker asks for the delivery ZIP code before it shows some shipments, with `"needed":
  "zip"` and no shipment. The adapter sends no ZIP code, so that answer needs input.
- Some numbers get an HTTP 500 error page from the service, which is inconclusive.
- Only the shipment whose `trackingnumber` is the number asked counts, and only when it is the
  one such shipment.
- Recognition makes the same request.

## Notes

- Each event's `datetimeGMT` is GMT to the minute, as the page reads it, and is kept as an
  instant. The delivery event and the proof of delivery's local time differ by the recipient's
  offset, and estimates of 5:00 PM deliveries land on 5:00 PM local time in both seasons.
- The event's `code` (`OHD`) stages it. The appointment event (`APP`) carries the appointment's
  time rather than a scan's and the page leaves it out of the status, so it is not kept. The
  page also hides `REC` from the history, and so does the adapter.
- The estimate is the day of the scheduled delivery the page shows, else of the estimate event
  (`ETD`). It is an instant without the recipient's zone, so its day is read in Eastern time,
  where a delivery's hours anywhere in the contiguous states fall on the same date. The time
  window and the appointment are not kept, and a closed or delivered shipment has no estimate.
- A closed or cancelled shipment (`CLS`, `CXL`) is an exception.
- The weight is the freight lines' total, which the page shows in pounds. Their contents,
  pieces and dimensions are not kept.
- The name that signed for the delivery, the reference number, the freight's last city, the
  delivery agent's tracking link and EFW's contact and chat details are not kept.

## Limitations

- No location for the events: the page shows the freight's last city apart from the history.
- A shipment the tracker shows only with its delivery ZIP code is not read.
- A number reaches the adapter when it is filed under EFW or opened from an EFW link: no rule
  claims EFW's numbers, so preflight does not ask it.

## Numbers

The adapter takes EFW's housebill number, seven digits, as every housebill in the archived and
live lookups. Housebills are reused: an archived number can now name a later shipment. The
tracker also takes longer retailer or partner references, which the adapter leaves to the
fallbacks. Bare digit runs are shared by many carriers, so no rule claims them. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking site opens `efwtrack.com/track/{number}`, optionally followed by the delivery
ZIP code; `efwnow.com` takes the number in `txtInputNo` on its tracking and My EFW pages and
opens the same tracker. The library reads the number from those addresses.

## Testing

`npm run test:carriers:live -- carriers/estes-forwarding`, with
`ESTES_FORWARDING_TRACKING_NUMBER` and optionally `ESTES_FORWARDING_UNKNOWN_NUMBER` set outside
the repository.
