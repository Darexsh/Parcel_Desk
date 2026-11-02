# ArrowXL

ArrowXL delivers large items such as furniture and appliances across the UK with two-person
crews, and collects them from customers for retailers. Tracked through its tracking page,
with the delivery postcode.

## How it works

1. `direct`: one `GET https://askaxl.co.uk/tracking?upi={reference}&postcode={postcode}`, as
   the form on that page and on arrowxl.co.uk's home page sends it. It needs no cookie, token,
   key or browser. The server renders the delivery or collection with its rows, newest first.

- Every lookup needs the postcode, but a parcel can be added without one. Without it the
  tracker shows nothing, so the adapter makes no request and reports `input_required`, and
  enabled universal providers answer instead. The postcode goes in capitals, its spaces
  collapsed.
- An unknown reference, a wrong postcode and a parcel the tracker no longer holds all come
  back on the form with "Invalid UPI number". That notice does not show the parcel is
  missing, so it is `indeterminate` (`portal_not_found`). It counts only when the form holds
  the reference asked.
- The found pages do not repeat the reference, so only the page for the address asked counts:
  a redirect, a 404 or a 410 is a moved route. A block page in place of the tracker is a
  challenge.
- Failures drop the request and response details `fetchBounded` attaches: the address holds
  the postcode.
- There is no recognition, since every lookup needs the postcode.

## Notes

- Rows carry the depot's wall clock to the minute, without an offset, and stay `local_time`.
  Current pages give a day and a month without a year: the year is the latest that puts the
  clock no later than the day after the lookup in the UK. Older pages wrote the year and
  listed the oldest row first.
- Rows have no code. The wording stages them; bookings, route plans, postponements and
  customer service's notes move nothing. Wording the map does not know goes to the shared
  wording rules.
- The depot after a row is its location. Current pages put "Local Hub" for every depot, which
  names no place and is not kept.
- The day a booking, route plan or postponement names, as "Customer Booked 12-MAR-2026", is
  the expected delivery while the parcel is on its way, until an attempt or a delivery comes
  after it.
- On the delivery day, while the crew is out, the page shows the crew's first names, the
  stops before the customer's, today's window and a map of the van instead of the rows. The
  adapter reads it as out for delivery today, a summary without scans, and keeps none of the
  rest.
- A collection is accepted once collected and returned once sent on to the retailer's
  returns site.
- With no rows, the progress bar's step is the status. Its last step settles a delivery whose
  success row is missing.

## Limitations

- No weight, no scan times as instants and no delivery time.
- A booking, route plan or postponement carries its day in the wording, so the status map
  cannot list it as an intentional gap.

## Numbers

ArrowXL's tracker asks for the tracking reference and the delivery postcode. Its help page
says the reference is usually 10 to 13 characters of letters and digits, and the tracker asks
for 13 characters starting with `8` and ending in a letter. Lookups archived from the tracker
and an aggregator's sample carry that reference with a three-digit suffix, 16 characters in
all; the tracker reads the reference and ignores the suffix. Yodel prints the same layout, so
no ArrowXL rule claims it. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking form sends the reference as `upi` to `askaxl.co.uk/tracking`, but the tracker
shows a delivery only with the postcode, so no address opens one parcel. Archived lookups put
the reference in `upi` on `askaxl.co.uk/tracking` and on the former `arrowxl.co.uk/tracking`,
or in the first path segment after `askaxl.co.uk/trk/`; only the reference is read from them.

## Testing

`npm run test:carriers:live -- carriers/arrow-xl`, with `ARROW_XL_POSTCODE` and
`ARROW_XL_TRACKING_NUMBER` or `ARROW_XL_UNKNOWN_NUMBER` set outside the repository.
