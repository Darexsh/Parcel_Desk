# ICS Courier

ICS Courier is a Canadian courier owned by Purolator. It delivers next-day and ground parcels
for businesses and online shops across Canada, through its own branches and SMARTSpot pickup
points. Tracked through its tracking page's own lookup.

## How it works

1. `direct`: one `GET https://www.icscourier.ca/online-services/parcel-tracking.aspx?trackNums={number}`.
   The ASP.NET page looks the numbers in its address up on the server and renders a summary
   row for each, then the first one's history. It needs no cookie, view state, token or
   browser. The page takes several numbers; the adapter asks one at a time.
2. `retry`: the same request once more after a request that failed to reach the tracker or ran
   out of time.

- The tracker gives up on its own query after thirty seconds and redirects to its error page,
  which the adapter reports as inconclusive. A parcel it has not looked up lately can take
  longer than that, but the query goes on after the page gives up and the next request finds
  it further along. The first request stops at twenty-five seconds so the retry starts before
  the error page would, and gets the rest of the budget.
- An unknown number gets a summary row saying `Not Found` and no history.
- The summary row and the history's heading must both name the number asked.
- A refusal or a bot check is a challenge, never a missing parcel.

## Notes

- Scans are wall clocks to the second with no zone, so they stay `local_time`. The tracker
  stamps unknown numbers with Eastern time, but nothing shows whether a branch's scans use
  the branch's zone or the server's.
- The page lists rows in the order they were recorded, which is not always the order of their
  clocks: a branch can record its arrival after the sort that followed. The adapter orders
  them by clock and keeps the page's order between equal clocks.
- `Shipping label created` comes from the shipper's label before ICS has the parcel. Its clock
  is 01:00 on the label's day, not the time it was made.
- Branch rows name the branch's town and province, which become the scan's location. Quebec
  branches use `PQ`.
- The delivered row goes on to name the recipient and their address, and the picked-up row the
  shipper or drop-off shop. Only their openings are kept. A delivery attempt keeps the driver's
  reason unless it holds a digit. The signatory, the signature image and the recipient and
  shipper details are not kept.
- A parcel left at a SMARTSpot shows the point's name, address, hours and position in a panel.
  The name and address become the `pickup_point`; the hours and coordinates are not kept.
- The summary's estimated delivery day is kept while the parcel is on its way and the day has
  not passed its newest scan.

## Limitations

- The tracker also finds parcels by delivery-notice number or by a reference with a postal
  code. Neither is a tracking number, so the adapter does not track them.
- Older parcels keep only their delivery row.
- No weight, service name or delivery time as an instant.
- No recognition: a parcel the tracker has not looked up lately takes it most of a minute,
  more than recognition's budget.

## Numbers

ICS tracking numbers are twenty letters and digits: `ND` for next-day or `GR` for ground
service, twelve letters and digits, then the destination postal code without its space.
Lookups archived from ICS's own tracker show both services. `ics-courier-1` claims that
layout. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker reads one or more numbers from `?trackNums=` on `icscourier.ca`, on both
`/online-services/tracking.aspx` and `/online-services/parcel-tracking.aspx`.

## Testing

`npm run test:carriers:live -- carriers/ics-courier`, with `ICS_COURIER_TRACKING_NUMBER` and
optionally `ICS_COURIER_UNKNOWN_NUMBER` set outside the repository.
