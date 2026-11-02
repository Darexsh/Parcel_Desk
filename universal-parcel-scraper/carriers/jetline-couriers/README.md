# Jetline Couriers

Jetline Couriers is a domestic courier network based in Patna, India. Tracked through the
tracking form on its home page.

## How it works

1. `direct`: `GET https://www.jetlinecouriers.in/`, then a `POST` of its form back to the same
   page with the page's hidden fields, the number and the track button, as the button does. The
   tracker redirects to `/track.aspx` under an opaque id for the number. The adapter opens that
   answer page, which summarizes the parcel, and posts the page back with its history link as
   the event target, as the link does. It needs no cookie, token, key or browser.
2. `retry`: an attempt that fails to reach the tracker, or hangs, is made once more. The first
   gets half of the budget.

- The history lists the parcel's rows newest first: a day, the badge of a branch and the row's
  wording, which carries no code.
- A number the tracker holds nothing under gets the answer page with an empty summary and the
  alert "No Record Available". That is the only missing parcel; an answer page without either
  the summary or that alert is malformed.
- A 429 is a rate limit, a 403 or a bot check a challenge, and a 404, a 410 or a redirect
  anywhere but the answer page a moved route.
- No recognition: no rule claims Jetline's numbers.

## Notes

- The summary and the history page name the AWB number in their one row, so the answer is bound
  to it: a row for another number, or several rows, are inconclusive.
- Every row is dated by its day alone, which stays a local date: there is no time to place on
  India's clock.
- A row's place is its branch's city, the part of the badge after the address and before the
  phones. A dispatch row's badge is the branch the parcel leaves for, so its place is the branch
  its wording says it leaves.
- A delivery settles the parcel. Otherwise the newest row with a known stage decides. Bookings,
  dispatches and receipts are staged by their opening words; a delivery run's outcome after
  "SHIPMENT CURRENT STATUS IS" by its wording.
- The branches' addresses and phones, the summary's route, booking day and status, and the proof
  of delivery are not read. Phones and anything after "SIGN" are dropped from the wording.

## Limitations

- No scan times, delivery estimate, weight or service.
- The history page carries the proof of delivery's photo, so a delivered parcel's page is far
  larger than the others. A page over 8 MB reads as inconclusive.
- The parser reads the summary as the tracker lays it out, with its seven columns, and the
  history as its timeline. Either laid out otherwise reads as a malformed reply, so the enabled
  fallbacks answer.
- The tracker answers older numbers with its missing-record alert, so an old parcel reads as
  missing.
- A number reaches the adapter when it is filed under Jetline Couriers: no rule claims its
  numbers, so preflight does not ask it.

## Numbers

The tracker takes AWB numbers. Its own example and a complaint show nine-digit numbers, and
comments on a tracking guide show seven- and eight-digit ones. The adapter sends runs of seven
to nine digits and nothing else. Digit runs of these lengths are printed by many other carriers,
so no rule claims them. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker posts its form back to the same page and opens the answer under an id it derives
from the number, so no address built from the number opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/jetline-couriers`, with
`JETLINE_COURIERS_TRACKING_NUMBER` and optionally `JETLINE_COURIERS_UNKNOWN_NUMBER` set outside
the repository.
