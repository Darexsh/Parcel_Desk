# ST Courier

ST Courier is a domestic courier network in India, based in Chennai. Tracked through the lookup
its tracking page makes.

## How it works

1. `direct`: two requests to `stcourier.com`, as the tracking form makes them.
   - `POST /track/doCheck` with the form field `awb_no={number}`. It needs no cookie, token,
     captcha or account. Its JSON answer, `{"code":200,"msg":"Track Shipment"}`, comes with a
     new `ci_session` cookie: the session the number is now filed in.
   - `GET /track/shipment` with that cookie, the page the form opens next. Its HTML shows the
     number filed in the session: the consignment's scans, newest first, beside a summary.
2. `retry`: a request that fails to reach the service, or hangs, is sent once more within the
   budget, in a fresh session.

- An unknown number gets the result page's "Sorry, Invalid AWB Number..!" with the number,
  which is not found. A number the lookup refuses gets `code` 400 and the form's message, which
  is invalid input.
- The result page names the number in its heading and in its complaint form; both must be the
  number asked. A page with neither a result nor the not-found answer held no lookup in its
  session, which is inconclusive.
- A 403 is a refusal; a redirect or a 404 is a moved route. Errors leave out the request
  details, which hold the session cookie.
- The page's complaint form carries a reCAPTCHA, so only a bot check in place of the page is a
  challenge.
- Recognition makes the same requests.

## Notes

- Each scan's clock is a wall clock to the minute, such as `Sep 25, 2025` and `07:24 PM`, with
  no zone. Every scan is at an ST Courier branch or hub in India, which keeps UTC+5:30 all year,
  so the clocks are read in `Asia/Kolkata` and each scan gets a `time`.
- Scans come without a code, so their wordings stage them. `Received at Hub` is in transit,
  which the shared wording rules would read as an acceptance. `Forwarded to …` ends with the
  next branch's code. A return to origin, worded `RTO …`, is an exception until it is delivered
  back, then returned.
- A scan's second line is its place, as `Sample hub, TN`. A line of another shape could name a
  person, so only a branch or hub with its state's code is kept.
- The summary shows a status, the booking and destination branches, the consignment's kind and
  count, and the booking and delivery times. For a consignment the page has no booking for, it
  says "In Transit" with empty fields whatever the scans say, so only a booked summary counts.
  A booked summary's delivery or return stands over the scans, which can stop at a hub scan,
  and its delivery time is the delivery time. A booked summary without scans is a summary-only
  answer.
- A delivery's wording loses the name of who took the parcel, and every wording loses phone
  numbers. The branches, the consignment's kind and count, the booking time and the complaint
  form are not kept.

## Limitations

- No expected delivery, weight, sender or provider code.
- Older consignments can keep only some of their scans and lose their booking summary. One ST
  Courier no longer keeps gets the same answer as an unknown number, so not found also covers
  it.

## Numbers

ST Courier AWB numbers are eleven digits. The tracking field takes digits only and searches
once eleven are typed, and the lookup refuses any other length, or a first digit of zero, as
"not in the correct format"; the adapter refuses them too. Complaints quote eleven-digit AWB
numbers. Lookups archived from the carrier's older tracker show twelve-digit numbers starting
with zero, which the current tracker refuses. Digit runs of these lengths are printed by many
other carriers, so no rule claims them and preflight does not ask ST Courier: a number reaches
the adapter when the user, a link or a provider names the carrier. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The current tracker posts the number and opens a result page without it, so no address opens
one parcel. Lookups archived from the older tracker carry the number as `awb_no` or `awb` on
`stcourier.com/cgi_bin/show_status1.php`, which now answers with the site's not-found page; the
number is read from them.

## Testing

`npm run test:carriers:live -- carriers/st-courier`, with `ST_COURIER_TRACKING_NUMBER` and
optionally `ST_COURIER_UNKNOWN_NUMBER` set outside the repository.
