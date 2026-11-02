# TOPTRANS

TOPTRANS is a Czech and Slovak network that collects and delivers parcels and freight for
businesses through its own depots in both countries. Tracked through its tracking service on
apis.toptrans.cz.

## How it works

1. `direct`: one `GET https://apis.toptrans.cz/tracking?parcel_number={number}` for a shipment
   number, or `?item_number={number}` for a piece number. It needs no cookie, token, key or
   browser. The page is one table: the shipment's fields, then its scans, oldest first, in Czech.
2. `retry`: a lookup that fails to reach the service, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- An unknown number is HTTP 200 with the table's `Zásilka nenalezena` heading, which is not
  found. The service gives the same answer for a number sent in the other parameter, so a
  shipment number goes only to `parcel_number` and a piece number only to `item_number`. A 404
  or a redirect is a moved route.
- F5's rejection notice, which its firewall serves with HTTP 200, is a browser check. The APIS
  outage notice is maintenance.
- A shipment lookup must name the number asked as the shipment number (`Číslo př.listu`). A
  piece lookup must list a run of piece numbers (`Číslo kusů od` to `Číslo kusů do`) that holds
  the piece and spans no more numbers than the shipment has pieces. The shipment number is then
  the canonical number.
- There is no recognition: no detection rule offers TOPTRANS for a number, so preflight never
  asks it.

## Notes

- The tracking form on toptrans.cz asks for a reCAPTCHA. The tracking service's page reads the
  number from its address and asks for none. It is the page the catalog's link opens, and
  tracking integrations such as Retino's read it.
- Scan times are the depots' wall clocks, read in Europe/Prague; Slovak depots keep the same
  time. An archived reply places a scan after the capture time when read as UTC.
- The rows carry wording only, which stages them. A shipment back at the delivery depot after a
  round that did not deliver shows `Zásilka je na rozvozovém středisku` again, which stays in
  transit.
- A scan's location is its depot's town, without the depot's number. The row for leaving
  toward the destination depot names no depot.
- The delivery time comes from the delivery scan, and the weight from `Hmotnost kg`.
- A shipment without scans takes the page's `Stav zásilky` and is marked summary only.
- The drivers' names and phone numbers, the driver's text message, who took the shipment, the
  sender's reference, the note, the piece count, the pickup date and depots, and the cash on
  delivery are not kept.

## Limitations

- Czech wording only: the service has no other language.
- No delivery estimate, sender, recipient or service name.
- TOPTRANS drops old shipments, which are then not found.
- The website also finds a shipment by the sender's reference and the first letters of the
  ordering customer's name. The adapter takes only shipment and piece numbers.

## Numbers

Archived lookups on the tracking service show eleven-digit shipment numbers and piece numbers of
thirteen digits, and one of ten. All are bare digit runs that other carriers also print, so no
rule claims them. The adapter takes those three lengths; anything else is invalid without a
request. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking service on `apis.toptrans.cz/tracking` reads a shipment number from
`?parcel_number=` and a piece number from `?item_number=`. The tracking page on `toptrans.cz`
posts its form and has no address for one parcel.

## Testing

`npm run test:carriers:live -- carriers/toptrans`, with `TOPTRANS_TRACKING_NUMBER` and
optionally `TOPTRANS_PIECE_NUMBER` and `TOPTRANS_UNKNOWN_NUMBER` set outside the repository.
