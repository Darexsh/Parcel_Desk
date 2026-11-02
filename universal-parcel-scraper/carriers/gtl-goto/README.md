# GoTo Logistics

GoTo Logistics (GTL) is an Indonesian fulfilment and delivery company that started in the GoTo
group. It delivers marketplace orders with its own fleet and partner couriers and tracks them
from pickup to delivery under its own number. Tracked through its tracking page's own lookup.

## How it works

1. `direct`: one `POST https://gtl.id/api/csms/shipment/v2/shipment/tracking` with
   `{"awb": number}`, the lookup the tracking page on gtl.id makes for the number in its
   address. It needs no cookie, token or browser. A shipment's reply has its number and its
   scans, each with a code, a clock, a wording and a hub.
2. `retry`: one more read when the first fails to reach GTL or hangs, inside the budget.

- An unknown number is HTTP 422 with code 5413 and "Paket tidak ditemukan" ("shipment not
  found" in English), which the page reports as not found. The reply names no number. Another
  code, or 5413 marked retryable, is inconclusive, and a 404 or a redirect is a moved route.
- TikTok's gateway, which serves the site, can ask for its captcha by naming it in a
  `bdturing-verify` header instead of answering; the page then shows the captcha and asks
  again. The adapter reports that as a challenge, never as a missing parcel.
- A shipment must name the number asked as its `awb`, with or without the hyphen.
- Recognition makes the same request.

## Notes

- TKGTL numbers are printed and sent with a hyphen after `TKGTL`. The library compares numbers
  without it, so the adapter puts it back.
- The current lookup gives each clock as a date and a time without an offset, which stays
  `local_time`: Indonesia has three time zones and the reply names none. An archived reply of
  GTL's earlier lookup gave ISO times in UTC; a clock with an offset, or in epoch
  milliseconds, is kept as that instant.
- A scan's code, such as `sc_inbound` or `delivery_start`, stages it and is kept as its
  provider code. The courier leaving the delivering hub and the run to the address share
  `delivery_start`, so both are out for delivery. A scan without a known code, like the first
  one, is staged by its wording: Indonesian sentences now, short English labels in the earlier
  lookup. There "Parcel ready for pick-up" came between two sorting centres, where the parcel
  waits for the next leg's driver, so it stays in transit rather than ready for pickup.
- Each scan's hub becomes its location, without the `-` placeholder. The earlier lookup gave a
  `location` instead, mostly empty, which the adapter also reads.
- A delivery can name who took the parcel after "oleh" ("by"). The adapter keeps the sentence
  up to "diterima" and takes phone numbers out of every scan.

## Limitations

- No delivery estimate. Only the number and the scans are kept; the reply's summary and the
  people it names are not.

## Numbers

GTL numbers were `TKGTL`, a hyphen, then eleven digits and capital letters. Newer ones are
`GTL` and ten digits. The library compares numbers without hyphens, so `gtl-goto-1` claims
TKGTL followed by eleven digits and capital letters, and `gtl-goto-2` claims GTL followed by
ten digits; no other carrier's numbers or rules use those prefixes. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracking form opens `gtl.id/tracking?tracking_number={number}`, which looks the number up
when the page loads. Archived lookups use the same address on `www.gtl.id`, which no longer
resolves.

## Testing

`npm run test:carriers:live -- carriers/gtl-goto`, with `GTL_GOTO_TRACKING_NUMBER` and
optionally `GTL_GOTO_UNKNOWN_NUMBER` set outside the repository.
