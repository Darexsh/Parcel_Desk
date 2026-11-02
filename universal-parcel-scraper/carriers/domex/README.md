# Domex

Domex, run by Domestic Express, is a Sri Lankan courier. Its branches collect parcels from
senders, online shops among them, and pass them through its sorting hub to the branch that
delivers. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://domex.lk/Order-Details.php?wbno={number}`, the page the tracking
   forms on domex.lk open. It needs no cookie, token, key or browser. The server renders the
   waybill's tables and its tracking table, oldest first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- An unknown waybill is HTTP 200 with "Record Not Found!" and the number in the search box,
  which is not found. A 404, a 410 or a redirect is a moved route.
- The waybill table is headed by the number it answers, which must be the number asked. The
  page matches the whole waybill, in capitals or not, and never a part of it.
- Recognition makes the same request.

## Notes

- Each line's clock is to the minute, with no zone. Domex delivers only in Sri Lanka, which has
  one zone and no daylight saving, and its clocks follow the Sri Lankan working day: delivery
  rounds in the morning, hub scans overnight. They are read as Colombo time, +05:30, and give
  instants and `delivered_at`.
- A status line names the branch, hub or department that recorded it after "By", as
  "Parcel Received By {branch}". The wording before it stages the scan and the branch is its
  location. A line recorded at the sender's premises or by a head office department keeps its
  whole wording and has no location.
- Domex's customer is the sender, so "Return To Customer" is a return. A held parcel stays at
  the delivering branch, often day after day, and is an exception until it goes out again.
- The head office closes a waybill's accounts days after its journey ends; that line moves
  nothing.
- The page shows the sender's name, address and phone number, the recipient's name, phone
  numbers and town, who delivered and who took the parcel, the pickup date, the payment, the
  item type, the piece count and a weight the booking gives. None of it is kept.
- The home page's script still holds an older lookup on connectmesecure.com that no button
  calls. Domex's merchant API also tracks waybills, with an account's token. The adapter uses
  neither.

## Limitations

- No estimate, service, weight, sender or recipient.

## Numbers

Domex waybill numbers are digits: its API documentation shows eight and nine. The tracker also
knows waybills of two letters and nine digits. Many carriers print such runs, so no rule claims
them and preflight does not ask the adapter. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking forms on domex.lk open `domex.lk/Order-Details.php?wbno={number}`, and the
former tracking page read the same parameter.

## Testing

`npm run test:carriers:live -- carriers/domex`, with `DOMEX_TRACKING_NUMBER` and optionally
`DOMEX_UNKNOWN_NUMBER` set outside the repository.
