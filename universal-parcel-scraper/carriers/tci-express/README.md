# TCI Express

TCI Express is an Indian express carrier. Its branches book and deliver consignments across
India, by road and by air, through hubs between them. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://www.tciexpress.in/track-your-shipment?trackshipment={docket}&dwb=dwb`,
   the page the tracking form opens. It needs no cookie, token, key or browser. The server
   renders the docket's number and status line, then tables of its booking, its transhipments
   between stations and its delivery runs.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- An unknown docket is HTTP 200 with the result block left empty, which is not found. A 404 or
  a redirect is a moved route.
- The result must name the docket asked. Older dockets can keep their delivery rows without the
  number above them; such a page cannot be told from another docket's and is indeterminate.

## Notes

- Transhipment rows give a despatch and an arrival, each a day and a wall clock to the minute
  with no zone. Every station is in India, which keeps UTC+5:30 all year with no daylight
  saving, so the clocks are read in `Asia/Kolkata` and each scan gets a `time`.
- Booking and delivery rows give a day alone, kept as `local_time` with no `time`. Within a day
  they follow the order of the page: the booking first, the delivery rows last.
- The tables have no status text of their own for the booking and the legs, so the adapter
  writes `Booked`, `Despatched to {station}` and `Arrived`. Delivery rows keep the carrier's
  wording, such as `Shipment delivered` or the reason a run left the parcel.
- The status line above the tables sums up the newest row and is not read.
- The booking row gives the expected delivery day and the weight in kilograms. The expected
  delivery is dropped once the docket is delivered.
- The destination pin code and location, the packet count, the note after the delivery station
  and the proof-of-delivery button are not kept, and delivery rows lose phone numbers.

## Limitations

- No time for a delivery, so no `delivered_at`.
- The tracker drops booking and transhipment rows of older dockets before their delivery rows,
  and some old dockets come back empty, as not found.
- No sender, recipient or service.

## Numbers

TCI Express tracks a consignment by its docket number, nine or ten digits. Digit runs of these
lengths are shared with other carriers, so no rule claims them. The nine-digit dockets seen so
far end with the first eight digits modulo 7, a check the page's script once made and no longer
does; the adapter does not require it. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker opens a docket from its `trackshipment` parameter, on `track-your-shipment` or the
older `trackingdocket.aspx`, which serves the same page. The parameter can list several dockets
separated by commas; those addresses are recognized.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Testing

`npm run test:carriers:live -- carriers/tci-express`, with `TCI_EXPRESS_TRACKING_NUMBER` and
optionally `TCI_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
