# Madhur Courier Services

Madhur Courier Services is a domestic courier network in India. Tracked through the lookup its
C-Note tracking page makes.

## How it works

1. `direct`: `GET https://madhurcouriers.in/CNoteTracking`, which redirects to the same page
   under an ASP.NET session id in its address. The adapter opens that page and posts its form
   back to it with the page's hidden fields, the C-Note option and the number, as the search
   button does. It needs no cookie, token, key or browser.
2. `retry`: an attempt that fails to reach the tracker, or hangs, is made once more. The first
   gets half of the budget.

- The answer lists the consignment's rows, oldest first: a day, a transaction type, the status
  wording and the branches involved. The transaction type is the row's code, and the branch that
  made the entry is its location.
- A C-Note the tracker holds nothing under gets the same page without rows and without any
  notice, with the number left in the field. That is the only missing consignment; a page with
  another number in the field, or none, is inconclusive, and so is an empty one.
- A 429 is a rate limit, a 403 or a bot check a challenge, and a 404, a 410 or a redirect
  anywhere but the session page a moved route.
- No recognition: no rule claims Madhur's numbers.

## Notes

- The rows name no number, so the answer is bound to the request: the form must come back with
  the whole number in its field and the C-Note option chosen, and list one booking at most.
  Several bookings under one C-Note are inconclusive. The tracker's other option looks up a
  shipper's reference, which can match several consignments, so the adapter never uses it.
- Every row is dated by its day alone, which stays a local date: there is no time to place on
  India's clock.
- A delivery settles the consignment. Otherwise the newest row with a known stage decides. A row
  is staged by its transaction type; a delivery sheet update by its wording, which says whether
  the consignment was delivered.
- A booking's wording names the consignor and the consignee with an address, and the delivery
  rows name the receiver and the delivery staff with their phone. The adapter keeps the booking's
  route, the opening words of a delivery sheet update and the out-for-delivery row's transaction
  type, and drops the rest, the pieces and the remarks.

## Limitations

- No scan times, delivery estimate, weight or proof of delivery.
- The tracker shows nothing for an unknown C-Note, so a failure it hides the same way reads as a
  missing consignment.
- The parser reads the history table as the tracker lays it out, with its six columns. A
  history laid out otherwise, or split into pages, reads as a malformed reply, so the enabled
  fallbacks answer.
- A number reaches the adapter when it is filed under Madhur Courier: no rule claims its numbers,
  so preflight does not ask it.

## Numbers

The tracker takes a C-Note number or a reference number. Complaints show ten-digit and
eleven-digit consignment numbers and C-Note numbers made of a P and nine digits, and a lookup
archived from the older tracker shows a ten-digit number. The adapter sends those shapes and
nothing else. Digit runs of these lengths are printed by many other carriers, and a letter with
nine digits is also an Australia Post layout, so no rule claims them. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The current tracker posts its form back to the same page, so no address opens one parcel.
Lookups archived from the older tracker for consignments booked before October 2019 carry the
number as `cno` on `madhurexpress.net/madhurnet/cnsgtracking_2.aspx`; the number is read from
them. That host no longer answers.

## Testing

`npm run test:carriers:live -- carriers/madhur-courier`, with `MADHUR_COURIER_TRACKING_NUMBER`
and optionally `MADHUR_COURIER_UNKNOWN_NUMBER` set outside the repository.
