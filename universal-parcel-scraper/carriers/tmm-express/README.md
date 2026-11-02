# TMM Express

TMM Express is a Ukrainian courier that brings parcels into Ukraine through its Warsaw hub,
clears them through customs in Kyiv and delivers them inside the country; it carries domestic
parcels too. Its booking form lists Poland, Luxembourg and Belarus as origins. Tracked through
its tracker's own page.

## How it works

1. `direct`: one `GET https://ukr.tmm-express.com/en/trackparcels?num={number}&mark=is_code`,
   where `mark=is_code` says the input is an AWB number. It needs no cookie, token, key or
   browser. The server renders the consignment's Common information and its scans, newest
   first.
2. `retry`: one more attempt after a failure to reach the tracker, inside the budget.

- The page also carries the consignment as base64 XML for its download button. The adapter reads
  the scans from it, because only the XML has each scan's status code.
- The Common information table and the XML must both echo the number asked.
- A page without a consignment is not found only when Drupal's notice above it repeats the
  number asked and says nothing was found, as the tracker's Ukrainian notice
  `за запитом -{number} інформація не знайдена` does. The English page can show it in English or
  in the site's Russian source wording, as it does its buttons. Any other notice is
  inconclusive. A 404 or a redirect is a moved route.
- Recognition makes the same request.

## Notes

- Each scan's code stages it, in [`statuses.json`](statuses.json). The codes are the same on the
  English, Ukrainian and Polish pages, whose wordings and place names differ.
- Scan clocks are wall clocks to the second with no zone, from the Warsaw hub, Ukrainian depots
  and the origin country, so they stay `local_time` and the page's order stands. The Delivery
  Date repeats the delivery scan's clock and is not kept.
- The page can follow a scan's wording with ` - ` and a remark. Only the hub or partner depot
  that an import scan names is kept. Other remarks are free text: a change of address carries
  the new address, and a changed delivery date its time window.
- The Signature, which names whoever signed, the customer reference in the XML, the pick-up
  date, the origin and the destination town are not kept. The destination country comes from
  the XML.
- The Partner Connote is the parcel's number at a partner, and import scans name a partner's
  destination depot, but neither the page nor the XML names the partner, so there is no
  hand-off.

## Limitations

- No delivery estimate, weight, service, or scan time as an instant.
- The tracker also finds consignments by customer reference; the adapter asks for AWB numbers
  only.

## Numbers

The tracker asks for the AWB number. Archived lookups on it show ten-digit numbers for both
imports and domestic parcels, and the adapter takes ten digits. No rule claims them: ten digits
are DHL Express's waybill length and several other carriers print them too. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The tracker opens one parcel at
`ukr.tmm-express.com/en/trackparcels?num={number}&mark=is_code`. It has Ukrainian and Polish
pages under `/uk/` and `/pl/`, and archived lookups also use `/ru/` on the bare and `www` hosts,
so the library reads `num` on `trackparcels` pages of any TMM Express host. The number field
itself is the form at `ukr.tmm-express.com/en/callback`.

## Testing

`npm run test:carriers:live -- carriers/tmm-express`, with `TMM_EXPRESS_TRACKING_NUMBER` and
optionally `TMM_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
