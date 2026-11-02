# Connect Couriers

Connect Couriers is a Maltese courier and freight forwarder with its own fleet on Malta and
Gozo. It also works as a sub-agent of international express networks, so a parcel can reach
it on another network's waybill. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://www.connectcouriers.eu/wp-admin/admin-ajax.php` with the form
   fields `action=public_connect_tracking_tracking_action` and `tracking_number={number}`, the
   WordPress action the tracking page's script calls. The page adds a nonce, which the action
   does not check, so the lookup needs no cookie, token, key or browser. The JSON reply has the
   consignment's pieces, a progress rail and the scans grouped by day.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try
   gets half of the budget.

- An unknown number is HTTP 200 with `{"success":false}`, which the page reports as an invalid
  tracking number. The reply gives no reason, so a failure on the tracker's side would look
  the same. A failure that carries a reason is inconclusive. WordPress's HTTP 400 `0`, a 404 or
  a redirect is a moved route.
- The reply's `trackingNumber` and one of its pieces must be the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `stageDateTime` is a wall clock with no zone, which the page shows as it is, so
  the clocks stay `local_time`.
- The scans carry no code; their wording stages them. Within a day the reply lists them in no
  order, so the adapter sorts them by clock.
- A consignment of several pieces shares one history. Each scan lists the pieces it was made
  for, and the adapter keeps the scans of the piece asked and those that list none.
- The piece's headline status decides a delivery or a cancellation; otherwise the newest scan
  does.
- Each scan names the staff account behind it, which the page does not show and the adapter
  does not keep. The recipient's town, the piece count, the shipment date and the weight,
  dimensions and packaging, all free text, are not kept either. A signatory or phone number
  in a scan's wording is removed.
- The reply names no partner network or partner number, so there is no hand-off.

## Limitations

- No delivery estimate, scan location or clock as an instant.
- The tracker does not find a parcel by its consignment number.

## Numbers

The public sample is eleven bare digits, a length other carriers share, so no rule claims it.
The tracking page's field takes digits only. The sample and its source are in
[`numbers.json`](numbers.json).

## Links

The tracking page at `connectcouriers.eu/tracking/` reads a `tracking_number` parameter and
looks the parcel up when it opens.

## Testing

`npm run test:carriers:live -- carriers/connect-couriers`, with
`CONNECT_COURIERS_TRACKING_NUMBER` and optionally `CONNECT_COURIERS_UNKNOWN_NUMBER` set outside
the repository.
