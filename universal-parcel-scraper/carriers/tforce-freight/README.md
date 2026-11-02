# TForce Freight

TForce Freight, formerly UPS Freight, is a less-than-truckload carrier in the United States, with
service to Canada and Mexico. It moves palletized freight between its service centers and delivers
it, often by appointment. TForce Final Mile and TForce's parcel networks are separate carriers.
Tracked through the search its tracking page makes.

## How it works

1. `direct`: `GET https://www.tforcefreight.com/ltl/apps/Tracking` opens an anonymous session. The
   page sets an anti-forgery cookie and holds the matching `__RequestVerificationToken` near its
   top, with its dashes and underscores written as HTML entities, which the adapter decodes as the
   page's script does. A `POST` to the same address with the token, `ProNumbers={pro};` and an
   empty `TrackingByPROresponseToken`, as the page's search form sends them, returns the page
   with one result card per PRO. It needs no key, account or browser.
2. `retry`: one more session and search after a network failure or a timeout.

- An unknown PRO gets a card with the status `Not Available` and "Please check ProNumber"
  naming it. Only that answer is not found. A card without the notice, or a page without a card
  for the PRO asked, is inconclusive.
- The page holds a switch for a reCAPTCHA on the search, which is off. When it is on, the adapter
  stops with a challenge before it searches.
- The F5 firewall in front of the site serves its JavaScript check to clients that present a
  browser's User-Agent, with HTTP 200, and that page is a challenge. The package's default
  User-Agent gets the tracker.
- The site answers a refused token or a failure of its own with HTTP 500 and "Unable to process
  your request", which is inconclusive. A redirect or a 404 is a moved page.
- Recognition makes the same requests.

## Notes

- Each scan's date and twelve-hour time are the service center's wall clock, with no zone, so they
  stay `local_time`. A scan's location is that service center's city and state, also at the
  delivery.
- The history keeps the page's order, newest first by record. A record such as a delivery
  appointment can be entered after the delivery and is then listed below it.
- The status beside the PRO decides a delivery. Otherwise the newest scan with a stage decides,
  since the status stays `In Transit` through the delivery run and failed attempts.
- The tracker has no codes; the activity's wording stages each scan. An activity starting
  "Shipment not delivered." is a failed attempt, whatever reason follows.
- The estimate shows only before the delivery. The weight in pounds becomes kilograms, and the
  consignee's city line gives the destination country.
- The consignee and shipper, the signer, the delivery appointment, the bill of lading and PO
  numbers, the piece count, the trailers and the service centers' codes are not kept.

## Limitations

- No delivery time as an instant, and no proof of delivery.
- The adapter searches by PRO only. The tracker's search by bill of lading or purchase order also
  asks for the range of dates the freight shipped in.

## Numbers

TForce Freight tracks LTL shipments by nine-digit PRO numbers, as its tracking API manual
states. The tracker's own check takes nine digits whose last is the first eight modulo 7, or
eight digits, which it reads with a leading zero; the adapter applies the same check. Lookups
archived from its tracker and from the former UPS Freight tracker give samples. Nine digits are
shared by many carriers, XPO's PRO numbers among them with the same check digit, so a
low-confidence rule takes nine digits that pass the check: preflight asks TForce Freight beside
XPO and TNT, and none of them is chosen from the number alone. Another low-confidence rule takes
eight digits that pass the check; recognition does not ask about them, since eight digits are
mostly other carriers' numbers, such as Mondial Relay's. A PARS number for the Canadian border is TForce Freight's carrier
code 2205 and the PRO, as its [Canada page](https://www.tforcefreight.com/ltl/apps/Canada) states;
a rule offers TForce Freight first for one whose PRO passes the check (2205 is a multiple of 7,
so the check on the whole number is the PRO's), and the adapter searches the PRO. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker reads one PRO number or several from `?proNumbers=` on
`tforcefreight.com/ltl/apps/Tracking` and searches them on load. The former UPS Freight tracker
read `?TrackProNumber=` on `ltl.upsfreight.com/shipping/tracking/TrackingDetail.aspx`.
A PARS number opens the tracker with the PRO it carries after `2205`, which is all the tracker
searches.

## Testing

`npm run test:carriers:live -- carriers/tforce-freight`, with `TFORCE_FREIGHT_TRACKING_NUMBER` and
optionally `TFORCE_FREIGHT_UNKNOWN_NUMBER` set outside the repository.
