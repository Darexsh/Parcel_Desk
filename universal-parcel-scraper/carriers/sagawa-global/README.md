# SGH Global Japan

SGH Global Japan, formerly Sagawa Global Express, is SG Holdings' international arm. Its SGX
tracker covers international courier shipments into Japan from the group's stations abroad,
which Sagawa Express delivers after customs. Tracked through the SGX tracker's page.

## How it works

1. `direct`: one `GET https://tracking.sagawa-sgx.com/sgx/trackeng.asp?ENC=ENG&CAT=AWB&AWB={number}`,
   the address the tracking form on SGH Global Japan's support page opens, with the English
   page. It needs no cookie, token, key or browser. The page echoes the air waybill and lists
   its scans oldest first.
2. `retry`: the same request once more after a failed connection or a timeout.

- An air waybill the tracker does not know is HTTP 200 with `No Record.`, which is not found.
  A Sagawa Express domestic waybill that never went through SGX gets the same answer. A 404 or
  a redirect is a moved route.
- When a lookup matches several records, the tracker lists their air waybills instead of a
  shipment. That answer is inconclusive.
- The tracker matches the whole number only, and the page must echo the number asked.
- The tracker fails with its server's HTTP 500 page for some numbers it cannot read, such as
  all zeros; that stays inconclusive.
- Recognition makes the same request. With no detection rule, preflight does not ask SGX.

## Notes

- Each scan's clock is its station's wall clock to the minute, with no zone. Histories start
  at stations abroad, so the clocks stay `local_time`.
- The history lists the flight's expected arrival at the Japanese airport among the scans. It
  is a forecast and is dropped.
- `CLEARANCE RELEASE` and `Out For Delivery` are in transit. `Out For Delivery` is the
  hand-over to Sagawa Express at the airport, which delivers a day or more later.
- Sagawa Express's scans after the hand-over carry no place of their own: the page shows the
  destination station on them, which is not kept. The `[STAMP]` after `Delivered` says how the
  parcel was received and is dropped.
- The shipper's reference, the origin and destination stations and the proof of delivery are
  not kept.
- Once Sagawa Express has the parcel, the page's footer names its domestic waybill with a link
  to Sagawa Express's tracker. The adapter reports it as the delivery carrier's number, usually
  the air waybill itself, and leaves the lookup to the Sagawa Express adapter.
- The tracker also has an XML endpoint, `xmltrack.asp`, with status codes. Its details mix in
  internal references, so the adapter reads the page.

## Limitations

- No estimated delivery, weight or service, and no scan time as an instant.
- The tracker keeps a shipment for about two months after delivery.

## Numbers

SGX air waybills have twelve digits with the Sagawa Express check digit, and the tracker gives
the same number as the Sagawa Express domestic waybill. The sagawa rule already offers Sagawa
Express for that shape, so no rule claims it for SGX. Air waybills from Los Angeles can instead
start with IDA and twelve digits; the IDexpress rule leaves that layout alone, and no rule
claims it because one waybill shows it. The nine-digit references with a hyphenated suffix that
shippers give belong to the tracker's REF# search, not to an air waybill. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

`tracking.sagawa-sgx.com/sgx/trackeng.asp?ENC=JPN&CAT=AWB&AWB={number}` opens one air waybill,
as the tracking form on SGH Global Japan's support page builds it. Links that set `CAT` to a
reference or account search carry other identifiers in the same parameter.

## Testing

`npm run test:carriers:live -- carriers/sagawa-global`, with `SAGAWA_GLOBAL_TRACKING_NUMBER` and
optionally `SAGAWA_GLOBAL_UNKNOWN_NUMBER` set outside the repository.
