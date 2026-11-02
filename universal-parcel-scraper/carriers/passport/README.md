# Passport

Passport ships US merchants' parcels abroad and to Canada, and hands them to a partner in the
destination country, a national post or a courier such as UniUni or Intelcom. Tracked through
the merchant tracking page Passport's tracker opens.

## How it works

1. `direct`: one `GET https://track.passportglobal.com/{number}`. A known number is redirected to
   the merchant's page on a `passportglobal.com` subdomain under the same number, which the
   adapter then reads; some shipments answer on the tracker itself. A redirect anywhere else is
   inconclusive. No cookie, key, account, CAPTCHA or browser is needed.
2. `retry`: one more try when a request fails to reach Passport or hangs. The first try gets half
   of the budget.

- The page is server-rendered HTML. Its script receives the shipment as JSON; the page counts
  only when that shipment's tracking code is the number asked for. The history comes from the
  page's rows, newest first.
- An unknown number gets HTTP 200 with the notice "We can't find the tracking number" followed
  by the number. Only that notice naming the whole number is a missing shipment; any other page
  without a shipment is inconclusive. HTTP 403, which the site gives some automated clients, and
  its Human Verification page, which automated browsers get, are challenges.
- Recognition makes the same lookup. `passport-1` offers Passport, so preflight asks this adapter.

## Notes

- Rows give a day, a month and a clock, without a year. The year is the one that puts the day
  after the order, whose time the shipment carries; without it, the one that puts the day before
  the lookup.
- The page labels every clock UTC. Passport's own rows, from the order to its origin processing
  centre, are UTC, as are the rows it relays from UniUni and Parcel Right (DAI Post's Australian
  brand, named as DAI Post), which it converts.
  Other partners' rows, such as Royal Mail's and PostNL's, are their wall clocks under the UTC
  label, so they are kept in `local_time`.
- Rows the page marks "Estimated" fill a milestone Passport did not scan, and are not read.
- The local delivery partner is `delivery_carrier` when its name and link agree on a carrier of
  the catalog, and its number is `delivery_tracking_number` when it differs from Passport's. A USPS
  routing barcode loses the recipient's ZIP code. For an S10 number without a known partner, the
  destination's post is left to try. The destination country comes from the shipment.
- The estimate is the day or window the page shows, until delivery.
- A receipt after the parcel has moved on is in transit, not its acceptance.
- The recipient's town, the order reference, the merchant and the partner's phone number are not
  read. A row place that is a bare country or holds a digit is dropped.

## Numbers

Passport's own tracking numbers are `PG`, ten or eleven digits and the destination's country
code. `passport-1` claims the layout and the adapter takes nothing else. The tracker also answers
the numbers its partners track a parcel under, such as S10 or SSCC labels; they stay with those
carriers.

## Links

Passport's tracking page at `passportglobal.com/track/` sends the number through a form and has
no parcel address of its own. The library opens `track.passportglobal.com/{number}`; archived
lookups used `track.passportshipping.com/{number}`, which forwards there. Merchant pages,
`{merchant}.passportglobal.com/{number}`, are recognized too.

## Limitations

- Passport drops shipments after a few years; they read as not found.
- Partners' clocks other than UniUni's and Parcel Right's have no offset. Parcel Right's, as
  Passport converts them, can be an hour off, as Queensland's are.
- No weight, sender, recipient or proof of delivery.

## Testing

`PASSPORT_TRACKING_NUMBER=... PASSPORT_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/passport`
