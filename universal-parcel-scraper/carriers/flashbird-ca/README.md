# FlashBird

FlashBird is a same-day courier for online shops in Ontario and Québec, based in Concord,
Ontario, taking orders from Shopify and other platforms. Its site is flashbird.ca. Tracked
through the service its tracking page asks.

## How it works

1. `direct`: one `GET https://flashbird.ca/ghost/api/v0.1/package_trackings/{number}`, as the
   tracking page sends it. It needs no cookie, token, key or browser.
2. `retry`: the request once more when it fails to reach FlashBird or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A number the service does not hold gets HTTP 200 with an empty object, which the tracking
  page reports as "No parcel details found". Any other reply without a history is a changed
  reply, not a missing parcel.
- The site answers a path it does not route with its blog's admin page and HTTP 200, so a reply
  that is not JSON is a changed route. A redirect or a 404 is a moved route, and a 429 a rate
  limit; the service announces a limit of 120 lookups a minute.
- The reply must name the whole number asked.
- Recognition makes the same request.

## Notes

- Each row's `time` is an instant in epoch milliseconds. The tracking page shows it on
  Toronto's clock, and so does the adapter, to the second.
- Rows come oldest first with FlashBird's English wording and no code; the page translates the
  rows it knows for French readers. The wording stages them.
- While the parcel is out for delivery, the reply gives the driver's arrival in seconds from the
  lookup. `expected_delivery` takes it, to the minute, where the page shows it: at most four
  hours ahead and by 23:00 that day, or later when the driver's route ends by 23:00. A delivery
  the recipient moved to a later day is that day.
- The reply also holds the keys of the delivery photos, which the page turns into image links,
  the driver's id, position and stops left, and a note the page can show. None is read.

## Limitations

- No places, weight or service.
- Only the four rows a delivery goes through have been seen. A failed delivery or a return
  would be staged by the shared wording rules.
- The tracking page also finds a parcel by the shop's order number with the recipient's postal
  code. The adapter looks up tracking numbers only.

## Numbers

Archived lookups on FlashBird's tracker hold twelve-digit numbers, which is what the adapter
accepts. Many carriers print twelve digits, FedEx's among them with the same leading digits,
so there is no detection rule. Recognition asks only the carriers a rule offers, so it does not
ask FlashBird.

## Links

Each parcel has its own page, `/tracking/<number>`, on flashbird.ca.

## Testing

`npm run test:carriers:live -- carriers/flashbird-ca`, with `FLASHBIRD_CA_TRACKING_NUMBER` and
optionally `FLASHBIRD_CA_UNKNOWN_NUMBER` set outside the repository.
