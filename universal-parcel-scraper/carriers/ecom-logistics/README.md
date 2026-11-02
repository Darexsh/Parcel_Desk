# Ecom Logistics

Ecom Logistics (ShipEcom, formerly EcomLogistics.ca) delivers e-commerce parcels the same or next
day with its own fleet from Toronto, Montreal, Vancouver and Philadelphia. Its site is shipecom.com.
The adapter reads its public tracking page.

## How it works

`GET shipecom.com/track/{number}` returns the page, rendered by the server, without a session or
CAPTCHA. Its result section names a state and repeats the number asked, which must be the one
asked. A known parcel has a status heading, a progress rail, its delivery time, the destination's
postal code prefix and the tracking history. Only the history is kept: each scan's wording, its
instant with an offset, and the town for a pickup. A number the tracker does not know comes with
HTTP 404 and the state `not_found`, which is read as not found; a 404 without it is a moved route.

Recognition asks the same page: a history says Ecom Logistics holds the number.

## Notes

- The scans carry no code; their wordings are mapped in [statuses.json](statuses.json), and another
  wording falls to the shared wording rules.
- The destination is a postal code prefix of the recipient's address, so it is left out.

## Numbers

An archived lookup on its own tracking page shows a parcel under E, two digits, a letter and seven
digits. One sample from one source gives a low rule. The adapter takes eight to thirty letters and
digits, as the page does not say which other layouts it issues.

## Links

The tracking page opens the number from its path, in English, French or Spanish.

## Testing

Set `ECOM_LOGISTICS_TRACKING_NUMBER` and `ECOM_LOGISTICS_UNKNOWN_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/ecom-logistics`.
