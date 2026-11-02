# Shree Anjani Courier

Shree Anjani Courier Services is a domestic courier based in Ahmedabad, with branches and
franchise counters across India. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://api-customer.shreeanjani.co.in/public/awb/{number}`, the request
   the page at `shreeanjani.co.in/tracking` makes. It needs no cookie, token, key, captcha or
   browser. The JSON reply has the booking, the hub and branch scans and the delivery run
   sheets.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- An unknown number is HTTP 200 with a booking that only echoes the number: no date, centres,
  status or scans. The page shows it as an empty card under the number. Old numbers read the
  same once the service no longer keeps them.
- The lookup checks the number itself and answers anything but ten to fifteen digits with HTTP
  400 and `Validation failed`, which is invalid input. A 404 or a redirect is a moved route, a
  403 a challenge and a 429 a rate limit.
- The booking must echo the number asked.
- Recognition makes the same request.

## Notes

- Scan and run sheet clocks are UTC instants, which the page shows in the visitor's zone. They
  are given in India's zone. The booking date is a calendar day stored as midnight UTC, and it
  stays a day: a scan the evening before in UTC can fall on it in India.
- The history is the page's: the booking at its centre, then the scans, then the run sheets.
  Older scans put a sentence where the first centre goes, such as `Out To B From A`, which is
  kept. Newer ones name both centres and get the same sentence. A scan's location is the centre
  that scanned it, and its `IN` or `OUT` status is the provider code.
- A run sheet is the branch sending the parcel out on a delivery round, with the outcome as its
  reason. `Delivered` is kept without a clause naming who took the parcel; a run sheet without
  an outcome reads `Out For Delivery`, as the page titles it. Other reasons go to the shared
  wording rules. The run sheet's clock is the one the booking's status date gives a delivery.
- The booking's status, such as `DELIVERED ON 4/3/2026`, heads the result and decides a
  delivery.
- Some numbers no one booked carry stray scans from unrelated centres months apart, under an
  empty booking or none. Without a booking such a reply is inconclusive rather than a history.
- The reply names the last centre's manager and phones, which the page shows. They are not
  kept, nor is the destination centre.

## Limitations

- No delivery estimate, weight, service name or proof of delivery.
- A delivery's instant is its run sheet's, not the moment of handover.

## Numbers

Shree Anjani air waybill numbers are ten digits. Customers quote them in complaints about the
courier. No rule claims them: many carriers print ten-digit numbers, and nothing in Shree
Anjani's sets them apart, so only a number filed under Shree Anjani reaches the adapter. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

`shreeanjani.co.in/tracking?awb={number}` opens one parcel: the tracking page reads the number
from `awb` and writes it there when the form is sent.

## Testing

`npm run test:carriers:live -- carriers/shree-anjani`, with `SHREE_ANJANI_TRACKING_NUMBER` and
optionally `SHREE_ANJANI_UNKNOWN_NUMBER` set outside the repository.
