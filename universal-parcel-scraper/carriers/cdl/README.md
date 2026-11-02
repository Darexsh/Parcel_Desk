# CDL Last Mile

Tracks CDL Last Mile parcels, a regional carrier from the US Northeast to the Mid-Atlantic,
through the service behind CDL's own tracking page.

## How it works

The tracking page at `apps.cdldelivers.com/Tracking-Page/track?id=<number>` is an Angular app
that asks `apps.cdldelivers.com/Tracking-Page-API/Tracking/details?value=<number>`. The adapter
sends that GET itself. It needs no account, key, cookie, token, CAPTCHA or browser. A request
that fails to reach CDL is sent once more within the budget.

A known number gets JSON with the parcel's tracking information and its scans. The parcel's
package reference must be the whole requested number; a parcel under another reference is
inconclusive. An unknown number gets an empty HTTP 204, the only missing parcel. Redirects,
HTTP 404, an empty or `null` HTTP 200 and a parcel without scans stay inconclusive, and block
pages, rate limits and other HTTP errors keep their own failure kinds. Recognition uses the same
lookup.

## Numbers

The service matches a number only as printed, case aside, in the page's package reference or
tracking number field. The adapter takes CDL's label numbers, `CDL` and eleven digits, which
`cdl-1` claims, and its order numbers, nine digits, a hyphen and one digit. Normalization drops
that hyphen, so the adapter and the tracking link put it back before the last digit of any ten
digits. `cdl-2` offers CDL for those only when they are typed with the hyphen, so recognition is
asked about them then.

The same reference field holds shippers' own references, which can be short order numbers of
any shape and can match another customer's parcel, so other numbers are invalid without a
request and go to the universal providers. The page's tracking number, digits, a dot and a
six-digit date, loses its dot to normalization and is not taken either.

## Notes

- The scans carry wording without codes. [status.ts](status.ts) maps them whole; other wording
  goes to the shared rules. CDL flags some scans as exceptions: a flagged wording the map does
  not know is an exception, or a failed attempt or return when the shared rules say so. A parcel
  awaiting its shipper is flagged as a delay but stays registered, since CDL does not have it
  yet.
- Clocks have no offset. CDL's former tracker labelled them ET, and the creation times that some
  shippers' references embed match the label scan in Eastern time, so they are read in
  `America/New_York`.
- The completed delivery is stamped on its whole minute, so it can read a few seconds before the
  scan at the door that came first. Scans are sorted by clock with the completion last in its
  minute. A delivery listed twice, once per photo, is one scan.
- The page leaves out where the label was made, and so does the adapter.
- Delivery scans carry their proof-of-delivery photos inline, which makes a delivered parcel's
  reply a megabyte or more. The photos, the driver, where the parcel was left, the destination
  and the map position are never read. The address, instructions and notification settings the
  page shows after the delivery ZIP code is confirmed are not requested.

## Links

The tracking box on `cdldelivers.com` opens `apps.cdldelivers.com/Tracking-Page/track?id={number}`,
which shows one parcel; the library reads the number from such a link and builds it. The former
tracker at `ship.cdldelivers.com/Xcelerator/Tracking/Tracking` took `orderId` or
`packageitemrefno` and now redirects to the new page; the library reads both.

## Live test

Set `CDL_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/cdl/adapter.live.test.ts`. Optionally set
`CDL_UNKNOWN_NUMBER` to check a number CDL does not know.
