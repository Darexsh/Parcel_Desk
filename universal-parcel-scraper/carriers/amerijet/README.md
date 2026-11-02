# Amerijet

Amerijet International is an all-cargo airline based in Miami that flies to the Caribbean
and Latin America. Tracked through the lookup its air waybill tracking page makes.

## How it works

1. `direct`: one
   `GET https://amerijetprod.wpenginepowered.com/api/index.php/tracking/getTrackingInfo?awbNo={number}`,
   with the prefix and the serial run together, as the tracking page on amerijet.com sends it. It
   needs no cookie, token, key or browser. The JSON reply lists the air waybill's scans.
2. `retry`: the same request once more after a failed connection or a timeout.

- An unknown air waybill is HTTP 200 with `{"Message":"AWB does not exist."}`, which the page
  reports as not found. Any other message is the service failing and stays inconclusive. A 404
  or a redirect is a moved route.
- Cloudflare in front of the lookup blocks some clients' names outright, such as a bare
  `Mozilla/5.0`, with its 403 page. The package's default User-Agent passes.
- Every scan must echo the air waybill asked.
- Recognition makes the same request. Detection claims only the dashed form, which needs no
  recognition, so preflight does not ask Amerijet about the bare eleven digits.

## Notes

- The page shows each scan's day from `TMEVENTDATE` and its time from `TMEVENTTIME`, under the
  heading "local time": each station's wall clock, with no zone. One history crosses several
  zones, so the clocks stay `local_time`.
- The reply lists scans by milestone rather than by time. The adapter puts them newest first by
  wall clock, and by milestone within one clock.
- The milestone word (`Booked`, `Accepted`, `Departed`, `Arrived`, `Delivered`) stages a scan
  and is its provider code. `Delivered` is the hand-over to the consignee or its agent at the
  destination station, which ends the air waybill's journey.
- The location is the scan's station, an IATA airport code.
- A scan that moved only part of the shipment's pieces says so after its wording, as
  `Departed from MIA (2 of 5 pieces)`.
- Flight and truck numbers are not kept.

## Limitations

- No estimated arrival, weight, origin or destination country, and no scan time as an instant.

## Numbers

Amerijet tracks a shipment by its air waybill: the airline prefix 810, then an eight-digit
serial whose last digit is the remainder of the first seven divided by seven. The adapter
refuses a serial whose check digit fails. Amerijet's own pages print the number with a dash
after the prefix, and rule `amerijet-1` claims that dashed form, which no other carrier prints.
The same eleven digits without the dash are shared by several carriers, so the rule leaves
them unclaimed. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker takes the prefix and the eight digits in two fields and looks them up from its
script. No address opens one shipment.

## Testing

`npm run test:carriers:live -- carriers/amerijet`, with `AMERIJET_TRACKING_NUMBER` and
optionally `AMERIJET_UNKNOWN_NUMBER` set outside the repository.
