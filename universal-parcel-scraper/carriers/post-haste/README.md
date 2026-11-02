# Post Haste

Post Haste is a Freightways courier that picks up and delivers parcels across New Zealand.
Tracked through the Freightways lookup under Post Haste's name, with the group's tracker and
parser ([freightways.ts](../nz-couriers/freightways.ts)).

## How it works

1. `direct`: one `GET https://public-website.ep-prod.freightways.co.nz/public-website/v1/carriers/PostHaste/tracking-events`.
   A courier ticket goes as `?searchType=TK&ticketProductCode={code}&query={number}`, a charge
   label, SSCC or customer printed label's consignment number as `?query={number}`. The number
   loses its leading zeros unless it is a 20-digit SSCC or a consignment number. It needs no
   cookie, token, key or browser. The JSON reply is the consignment with each of its parcels'
   scans, oldest first.

- An unknown number is an empty HTTP 204. A 404 or a redirect is a moved route.
- A consignment number, a sender's letters and digits, often fits a ticket's layout. Such a
  number is asked as a ticket first, then whole when the ticket gets a 204, in one step.
- The reply's `shortConsignmentId` must be the number asked: the ticket's product code and
  number, the label alone, or a consignment number after the sender's account number.
- Recognition is off. The lookup answers for every Freightways network, and New Zealand
  Couriers prints the same tickets and labels, so a known answer would not show that a number is
  Post Haste's.

## Notes

- The tracking page on posthaste.co.nz asks the same consignment through its web agency's proxy,
  `web-api.freightways.makerdesign.co.nz/track`. Post Haste's receiver site carries the direct
  lookup in its script, and New Zealand Couriers' page makes it, so the adapter asks Freightways
  directly.
- Scan times are UTC instants, kept as they are. Scan types share New Zealand Couriers' status
  map.
- Each scan names the Freightways network that made it. When the newest is another catalog
  carrier's, such as New Zealand Couriers, that carrier becomes the delivery carrier.
- A customer printed label's consignment number is found only under the network that issued
  it, so one asked under another Freightways network reads as not found.
- The reply's `ETA`, which the page does not show, is a weekday and a date without a year. It is
  dated from the parcel's first scan and kept only when the weekday agrees.
- Signatures with the signatory's name, delivery photos, the authority-to-leave tag, the
  barcode, postcodes, branches, drivers and runs are not kept.

## Limitations

- A customer printed label is read only by its consignment number, in the layouts New Zealand
  Couriers' adapter reads ([README](../nz-couriers/README.md)), so a number of another carrier's
  layout, such as Purolator's three letters and nine digits, is refused. A label the lookup
  finds only with the sender's account needs the tracking link that names it, as for New Zealand
  Couriers. Contract bags and manifest references are not read.
- A consignment the tracker no longer holds reads as not found.
- No weight or service.

## Numbers

A courier ticket or Express Pack carries a product code of up to four letters and an eight-digit
ticket number, which the advanced tracker takes as two fields; the corpus writes them with a
space between. Charge labels carry an eight-digit label number. Customer printed labels pair the
sender's account number with a consignment number, so they are not kept. The track and trace
page gives the samples, and archived lookups on the tracker give the tickets. New Zealand
Couriers, another Freightways brand, prints tickets in the same layout, and eight digits are
shared by many carriers, so no rule claims either. A consignment number is the sender's own, as
[New Zealand Couriers' notes](../nz-couriers/README.md#numbers) describe, so no rule claims it.

## Links

The site's search box sends a number to `posthaste.co.nz/track?query={number}`. The receiver site,
`receiver.posthaste.co.nz`, and the older servlet at `/phl/servlet/ITNG_TAndTServlet` are read as
for New Zealand Couriers ([README](../nz-couriers/README.md)).

## Testing

`npm run test:carriers:live -- carriers/post-haste`, with `POST_HASTE_TRACKING_NUMBER` and
optionally `POST_HASTE_UNKNOWN_NUMBER` set outside the repository.
