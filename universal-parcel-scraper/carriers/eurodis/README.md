# EURODIS

EURODIS is a European parcel and pallet network run from Weinheim that links national carriers,
its members; Austrian Post is the member for Austria and trans-o-flex the member for Germany. A
shipment is carried by the member in the country of dispatch and handed to the member that
delivers it. Tracked through EURODIS's own tracker for the whole network.

## How it works

1. `direct`: a collo barcode is one `GET https://eurodis.com/track-trace?{barcode}`, the address
   a result page gives itself. A shipment number is one `POST https://eurodis.com/track-trace`
   with `track_and_trace_hidden_field=trackEurodis&trackEurodis-input={number}`, as the page's
   shipment-number form posts it. The page is rendered on the server and needs no cookie, token
   or browser; without the site's language cookie it is in English.
2. `retry`: one more try when the request fails to reach EURODIS or hangs. The first try gets
   half of the budget.

- A number the tracker does not know gets HTTP 200, the search forms and the notice "No
  shipment matching with the entered tracking criteria!": `NotFoundError`. Another notice, or
  a page with neither a notice nor a shipment, is inconclusive. A redirect or any other HTTP
  status is a moved page.
- A found page has the shipment's overview and history, then each collo with its own overview
  and timeline. A barcode must be one of the colli, or a collo's delivery-partner number, and a
  shipment number must be the shipment's own. A page for another shipment, or for several, is
  inconclusive.

## Notes

- A barcode returns its collo's timeline. The shipment's history joins it only when the
  shipment has that one collo, since in a larger shipment it can concern another. A shipment
  number returns every collo's scans and the shipment's history. A shipment scan a collo also
  lists at the same minute and place, such as "delivered completely" beside the collo's
  "delivered", is kept once, as the collo's.
- A scan has a wall clock to the minute and no offset, and most name their place and country.
  The clock is read in the zone of the country the scan names. The delivery depot and the
  round can name no place: once the newest scan that names a country is in the destination
  country, the later scans are read in that country's zone. Any other scan without a country
  keeps its wall clock in `local_time`.
- Stages come from the wording, since the tracker has no codes. A "special delivery agreement"
  moves nothing.
- Once a shipment reaches the destination country, the page names the member the recipient
  should contact. When that is Express One or Austrian Post and the page gives the collo's, or
  the shipment's, delivery-partner number in a form that member's rules accept, the result
  names the member and that number as `delivery_carrier` and `delivery_tracking_number`. Other
  members have no adapter here.
- The page asks for the recipient's ZIP code before it shows the sender, the receiver and who
  took the parcel. The adapter never asks and reads only what the page shows without it. The
  shipper's reference, the number of colli and the members' contact details are not kept.
- The tracker also searches by the dispatching member's number with its country and by the
  shipper's reference with the destination postcode. The adapter uses neither.

## Limitations

- The tracker drops older shipments and then reports them not found.
- No current found page has been observed. The parser follows archived result pages of
  barcode searches.
- No weight and no delivery estimate.

## Numbers

EURODIS's tracker asks for a 24-digit collo barcode or a thirteen-digit EURODIS shipment number.
Some members put letters in front of the barcode, as on Slovak parcels, so the adapter takes 24
letters and digits. A sample result on EURODIS's own results page and archived result pages
show both layouts. Austrian Post's tracker follows the barcodes of parcels it sends abroad
through EURODIS, and `austrian-post-3` suggests Austrian Post for 24 digits. Both layouts are
lengths that several carriers' rules take, so no rule claims them for EURODIS, detection does
not offer it and preflight never asks it; the adapter declares no recognition. A lookup reaches
it when the caller names EURODIS or opens one of its links. The entry names the network that
universal providers report.

## Links

The barcode form on `eurodis.com` sends the number as `trackCollo-input-of` to
`eurodis.com/track-trace`, so
`eurodis.com/track-trace?track_and_trace_hidden_field=trackCollo&trackCollo-input-of={number}`
opens one parcel. Such links, with or without a language folder, are read for EURODIS. The
other search forms post their fields.

## Testing

`npm run test:carriers:live -- carriers/eurodis`, with `EURODIS_TRACKING_NUMBER` and optionally
`EURODIS_UNKNOWN_NUMBER` set outside the repository.
