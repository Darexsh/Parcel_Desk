# Hunter Express

Hunter Express is an Australian express freight and parcel carrier. Tracked through its public
tracker's own page.

## How it works

1. `direct`: one `GET https://portal.hunterexpress.com.au/Track/55010/{number}`, the address the
   tracker's search box builds. It needs no cookie, token, key or browser. The reply is the
   HTML page: a heading with the current status, the consignment's details, the driver's last
   reading and the delivery's details, a map, and the history table, oldest first.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A number the tracker has no consignment for gets its empty search form with "Missing or
  incorrect tracking number". Consignments it has dropped get the same answer, so it is
  inconclusive (`portal_not_found`), not a missing parcel.
- The page answers every number with HTTP 200, so a 404 or a redirect is a moved route.
- The details must name the whole number asked. The tracker shows it in upper case.

## Notes

- History rows group scans of one kind at one depot on one day and show only the day. Each
  grouped row's detail panel, which the page loads on a click, lists the scans with their
  clock; the panel's address already carries the group's scans as UTC ticks, so the first of
  them is the row's instant and no extra request is made. The ticks are used only when the
  address names the row's wording, depot, day and consignment, and fall on the row's day in
  an Australian zone; otherwise the row keeps its day as `local_time`.
- Pickup and delivery rows, and the dated status above the history, show a clock with the
  zone's abbreviation, such as `AEST`; the five Australian abbreviations give the offset, and
  another keeps the wall clock as `local_time`.
- A dated status above the history that is newer than every row, such as "OnDelivery, Left
  Depot" once the van has left, becomes the newest scan.
- The estimate is a day or a window of two days, until a delivery.
- The receiver's suburb and postcode, the item counts, the driver's position and queue, the
  receiver's name, the map's points and the authority-to-leave note are not kept.
- No recognition: the tracker's only answer for a number it has no consignment for is the
  inconclusive one, and other Australian carriers on the same consignment software print the
  same layout.

## Limitations

- No provider codes, service name or proof of delivery.
- Exception and return wordings have not been seen on the tracker; they fall to the shared
  wording rules.

## Numbers

Hunter Express consignments seen on its tracker and in reviews are three letters and six
digits, the letters set by the sender's account. Other Australian carriers on the same
consignment software print the same layout, so no rule claims it. The adapter sends six to
thirty letters and digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The public tracker opens one consignment at `portal.hunterexpress.com.au/Track/55010/` followed
by the number; its tracking script builds that address and archived lookups show it.

## Testing

`npm run test:carriers:live -- carriers/hunter-express`, with `HUNTER_EXPRESS_TRACKING_NUMBER`
and optionally `HUNTER_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
