# Bussgods

Bussgods carries parcels and pallets across Sweden, many of them on regular bus lines, with
agents where parcels are handed in and collected. Tracked through the lookup the tracking page on
bussgods.se makes.

## How it works

1. `direct`: one `GET https://backend.bussgods.se/api/transshipment/{number}`, as the page sends
   it. It needs no cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The JSON reply has the fraktsedel's `Information` and its `Statuses`, oldest first.
- The page reports any reply without scans as no result. For an unknown number the information
  names the number asked, or no number at all, which is not found. A fraktsedel the information
  describes (a product, parcels or a delivery town) but without scans has no history yet.
- A 404 or a redirect is a moved route.
- The reply must name the number asked, with or without `BG` in front of its ten digits.
- Recognition makes the same request.

## Notes

- Scan times are Swedish wall clocks without an offset, read in Europe/Stockholm. The page
  shows them as they come.
- The `StatusCode` stages a scan. Codes from 7 up are named in the page's script and worded in
  Bussgods' API documentation. The older codes are read by their wording, because the script and
  the documentation number them differently.
- `Anländ` (arrived at the agent, which texts the receiver) is ready for pickup, `Utlämnad`
  (handed out there) and `Utkörd` (brought to the door) are delivered. `Lämnad hos ombud` can be
  a sender handing the parcel in or a driver leaving it on the way, so it has no stage. A
  cash-on-delivery payout and a new number move nothing.
- The pickup point is the agent the page names for the arrival scan. A parcel handed out right
  after arriving keeps it; a door delivery does not. The page names no agent for station 5399.
- The service name is the product of a fraktsedel booked online. A parcel's scans repeat once
  for each of its parcels and are kept once. The parcel numbers and the delivery town are not
  kept.

## Limitations

- No sender, recipient, weight or delivery estimate: the anonymous reply has none.
- Scans are not split by parcel, so the parcels of one fraktsedel share one history.

## Numbers

Bussgods fraktsedel numbers seen on its tracker are `BG` followed by ten digits starting with
9, and ten bare digits. The adapter takes ten digits with or without `BG`; anything else is
invalid without a request. `bussgods-1` suggests the `BG9` layout at low confidence, because
two letters and ten digits also fit Aramex's and Colis Privé's rules; recognition asks Bussgods
first. Ten bare digits are shared by many carriers and stay unclaimed. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The site's search widget opens `bussgods.se/spara-paket/#{number}`, and the tracking page
reads the number from the fragment. The former tracker opened one parcel at
`bussgods.se/sok-paket/{number}`, with `/foretag/` in front for business customers.

## Testing

`npm run test:carriers:live -- carriers/bussgods`, with `BUSSGODS_TRACKING_NUMBER` and
optionally `BUSSGODS_UNKNOWN_NUMBER` set outside the repository.
