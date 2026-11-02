# ParcelABC

ParcelABC (Parcel ABC Limited) is a London booking site that sends parcels with partner couriers,
such as UPS, under its own order code and shows each parcel's history on its tracking page. It
has sites for several European countries. Its site is parcelabc.com. Tracked through its
tracking page.

## How it works

1. `direct`: one GET to the tracking page `www.parcelabc.com/track/<code>`, which the server
   renders with each parcel's rows.
2. `retry`: the same read once more after a request fails to reach the page or hangs. The first
   try gets half of the budget.

No account, key, CAPTCHA or browser is needed.

- The page needs the hyphen after the code's four letters, which the library's number does not
  keep, so the adapter puts it back.
- An unknown code is redirected to the home page with a new session whose notice says "Your
  entered parcel tracking ID is not valid". The adapter reads the home page once with the cookies
  the redirect set; only that notice is a missing order. A redirect elsewhere or without a
  session, another notice or none, and HTTP 404 stay inconclusive. A failure on the home page
  drops the request details, which hold the session cookie.
- The page repeats the code asked for in its heading, and the answer must name it.
- Block pages are challenges, and rate limits keep their own kind.

## Notes

- Each row has a clock, a place, ParcelABC's status from a fixed list the page explains, and a
  comment: the courier's own wording for its scan, or ParcelABC's note. The status stages the
  row, and the description is the status, then the comment after a colon.
- Clocks are wall clocks to the minute with no zone: the courier's local clock for its scans and
  ParcelABC's for its own rows, so they stay `local_time`.
- Comments and places lose British postcodes, phone numbers, e-mail addresses and a clause
  naming who received or signed for the parcel.
- An order of several parcels lists each one apart, usually with the same rows, which are kept
  once. The order stands where its least advanced parcel is, so one parcel's delivery does not
  deliver the order.
- Notes such as a partial refund, a closed order or a rearranged collection move nothing and
  map to `pending`; the stage stays the one before them.
- The page draws each parcel twice, for wide and narrow screens. Only the wide one is read.

## Limitations

- The page names no courier, courier tracking number, service, estimate or weight, so there is
  no hand-off.
- No instants.

## Numbers

Customer reviews show order codes of two country codes, a hyphen and nine digits. Other networks
use four letters and nine digits too, including Sunyou and Z-Leading, so there is no rule, and
the adapter tracks a code only when ParcelABC is chosen.

## Links

A tracking link opens the order code from its path. The page needs the hyphen, which the
library's number drops, so no portal link is published.

## Testing

`npm run test:carriers:live -- carriers/parcelabc`, with `PARCELABC_TRACKING_NUMBER` and
optionally `PARCELABC_UNKNOWN_NUMBER` set outside the repository.
