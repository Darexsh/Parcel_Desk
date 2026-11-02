# Followmont Transport

Followmont Transport is a Queensland road freight network with depots across Queensland and
New South Wales. Tracked through the lookups its Track & Trace page makes.

## How it works

1. `direct`: one `POST` of `{"ConsignmentIDs": number}` to the freight system's trace,
   `RETR_MISS_CONS_DATA___TM/1.0/Trace`, through the integration proxy the Track & Trace page
   on `www.followmont.com.au` calls. It needs no cookie, token, key or browser. The JSON reply
   has the consignment with each item's events. When the trace answers `Not Found`, a second
   `POST` asks the bookings search, `RETRI_CONSI_DATA___OEC/1.0/TraceUnsecured`, with `ConID`
   and the pickup window the page sends, from a month ago to tomorrow.
2. `retry`: the requests once more when they fail to reach the site or hang. The first try gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 200 with `Status: "N"` from both: `Not Found` from the trace and
  `Consignment Not Found` from the bookings search. Another `Status: "N"` is inconclusive. A
  404 or a redirect is a moved route.
- The page asks the bookings search first, then, for a consignment it finds, another flow by
  its consignment numbers. The trace holds a consignment's events whatever its pickup date, so
  the adapter asks it first.
- The bookings search does not answer without its date window.

## Notes

- The consignment must name the whole number asked, in `ConId` and in `ConsignmentNumber`
  where the reply repeats it. The bookings search also finds references and does not repeat
  them, so a booking that does not name the number is inconclusive.
- Each item is scanned on its own, so a scan of one kind at one place in the same minute is
  kept once, at its first clock.
- The reply writes event codes in camel case, such as `DepotIn`. The adapter keeps the code in
  upper case, as the page compares it, and the code split into words as the wording. The page
  derives one status from the newest event; the codes it maps give the stages. `Added` and
  `Shipper` only record the consignment in the system and have no stage.
- A consignment with only those records is booked, as the page shows it. One without events,
  or one only the bookings search holds, is booked as `summary_only`.
- Event clocks are wall clocks without a zone, and Queensland and New South Wales differ in
  summer, so they stay `local_time`.
- The estimate is a calendar day the reply writes as its last second, and is dropped after a
  delivery. The system writes 30 December 1899 where it has no date; such an estimate is empty
  and such an event is left out. A location with a digit is an address or a dock, not a town.
- Addresses, the sender, the receiver, the account code, delivery-proof flags, item barcodes
  and handling notes are not kept, nor the booking's suburbs, zones and dates.
- No recognition: no detection rule offers Followmont's numbers.

## Limitations

- The page shows the current status only, with the origin, destination, pickup date and item
  count, which are not kept.
- Sender references are not tracked: neither reply repeats a reference.
- A booking the freight system does not hold yet has no event, and the bookings search finds it
  only within the page's pickup window.
- Guest lookups carry no weight, service or proof of delivery.
- Exception and return codes have not been seen; those the map does not name fall to the shared
  wording rules.

## Numbers

Followmont asks for the connote number or the sender's reference. The consignment notes its
connote guides picture carry seven- and eight-digit numbers, and its tracker accepts letters
followed by digits. Many carriers print bare digit runs, so no rule claims them. The adapter
sends seven or eight digits, or one to three letters followed by six to ten digits. The samples
and their sources are in [`numbers.json`](numbers.json).

## Links

The Track & Trace page reads `consignmentNumber` from its address and searches for it at once.

## Testing

`npm run test:carriers:live -- carriers/followmont`, with `FOLLOWMONT_TRACKING_NUMBER` and
optionally `FOLLOWMONT_UNKNOWN_NUMBER` set outside the repository.
