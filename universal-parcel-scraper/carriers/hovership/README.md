# Hovership

Hovership Delivery is a US delivery service for same-day, next-day, two-to-four-day and bulky
parcels, run with its own drivers and partner carriers. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://www.hovership.com/track/{number}/`, the page the tracking form
   opens. It needs no cookie, token, key or browser. The server renders the parcel's status with
   its latest delivery time or its delivery, then its history newest first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- An unknown number is HTTP 404 with the page's own "Tracking number not found", which is not
  found. Any other 404, a 410 or a redirect is a moved route.
- The page heads a parcel with its number, and its ZIP code form carries it too. Both must be
  the number asked; a page for another number is inconclusive.
- The number goes in upper case, as the form sends it.
- Recognition makes the same request.

## Notes

- The page writes each scan's clock with its zone's short name, such as `PDT`, and Hovership's
  API gives every scan an instant and its zone. A scan's time is that clock in the named zone's
  offset. A zone the page named another way would leave the clock in `local_time`.
- A scan's title, such as `In Possession`, is its provider code and stages it; the line under it
  is its description. The API documents more statuses, for pickups, failed deliveries, holds and
  returns, whose titles the page has not shown yet. They fall to the shared wording rules.
- The estimate is the headline's "Arriving no later than" time.
- Phone numbers are dropped from every line, and a delivery's line loses who took the parcel. The
  origin and destination towns and the progress bar are not read. The ZIP code form unlocks the
  delivery address, the proof of delivery and, on some routes, a live ETA with the driver's
  first name and photo; the adapter does not use it.

## Limitations

- No scan location apart from the facility a line names, and no weight, service or delivery
  partner.
- Shippers can set numbers with dashes, which the library's normalization removes, and the
  tracker finds a number only as written. Such a number is reported not found.

## Numbers

Hovership's API documentation and an archived lookup on its tracker show numbers made of HV and
eight letters or digits. Shippers may also set their own numbers of up to 30 letters, digits,
underscores or dashes.

No rule claims Hovership numbers, so preflight does not ask the adapter. The shape cannot name
Hovership while shippers choose their own numbers, and some generated numbers also fall inside
C chez vous's low-confidence shape of four letters, two digits and four letters or digits. The
sample and its source are in [`numbers.json`](numbers.json).

## Links

One parcel opens on www.hovership.com under `/track/` followed by the number. The tracking form
builds that address after upper-casing the number and removing spaces, and the library reads
the number from it.

## Testing

`npm run test:carriers:live -- carriers/hovership`, with `HOVERSHIP_TRACKING_NUMBER` and
optionally `HOVERSHIP_UNKNOWN_NUMBER` set outside the repository.
