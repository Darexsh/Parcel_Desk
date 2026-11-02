# Pandu Logistics

Pandu Logistics, run by PT Pandu Siwi Sentosa, carries express and regular parcels between its
branches across Indonesia and delivers them to the door. Tracked through the lookup its
tracking page makes.

## How it works

1. `direct`: one `POST https://pandulogistics.com/wp-admin/admin-ajax.php` with the form
   `action=awb_tracking&awb={number}`, as the tracking page sends it. It needs no cookie, key or
   browser. The WordPress side asks Pandu's tracking service and returns its decoded answer
   under `json`, with the shipment's summary in `detail` and its scans in `track`, oldest first.
2. `retry`: a read that fails to reach the site, or hangs, is sent once more. The first gets
   half of the budget.

- An unknown number gets an empty answer from the service, a null `json` and the page's
  "Sorry, your tracking ID is not found". The service's own failure, which the reply carries
  under `request`, is inconclusive.
- WordPress answers 400 with `0` when no plugin handles the action, so a 400, a 404 or a
  redirect is a moved route.
- The shipment must name the number asked, and the reply must hold one shipment.
- Recognition makes the same request.

## Notes

- The page also sends a WordPress nonce from its form. The lookup answers without it, and its
  reply reports the check as failed whether the page's nonce is sent or not, so the adapter
  sends only the action and the number.
- Scan clocks are wall clocks to the minute with no zone. Pandu's branches span WIB, WITA and
  WIT and the tracker names none of them, so the clocks stay `local_time`.
- The delivery scan names the receiver and repeats its own clock; the adapter keeps
  `RECEIVED`. The summary's `DELIVERED` decides a delivery even when its scan has not come in.
- A branch arrival names the branch's city after `PSS`, Pandu Siwi Sentosa's initials, which
  becomes the scan's location. Other scans name no place.
- The reply carries the sender's and the consignee's names, their cities, the consignee's
  postcode, the contents and the receiver. None of them is kept; their names are also taken out
  of the scans' wording, and so are phone numbers. The weight is kept.

## Limitations

- No estimate, no service name and no delivery time as an instant.
- Shipments from the former tracking page's era are no longer on the tracker.

## Numbers

The POD number has eleven digits starting with `30`, as archived lookups on the carrier's
former tracking page show. Some AWB numbers have letters before the digits instead. No rule
claims either: eleven-digit runs are shared by many carriers.

## Links

The tracking page posts the number in a form, so no address opens one parcel. The former
tracking page took the number in its address, but it now redirects to the home page.

## Testing

`npm run test:carriers:live -- carriers/pandu-logistics`, with `PANDU_LOGISTICS_TRACKING_NUMBER`
and optionally `PANDU_LOGISTICS_UNKNOWN_NUMBER` set outside the repository.
