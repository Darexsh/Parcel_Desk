# Fastdrop

Fastdrop is the parcel delivery service of the eCabs group in Malta. Its booking and tracking
pages run on MotionTools, a delivery platform shared by several operators. Tracked through the
lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://api.motiontools.io/api/hailing/packages/{number}/tracking`
   with the header `X-Client-Version: eCabs Web Dashboard/1.0.0`, as the tracking page sends
   it. The header names the operator, so MotionTools looks the number up among Fastdrop's
   packages. The lookup needs no cookie, token, key or browser. The JSON reply has the
   package's status, its journey of stops and, near delivery, an estimate.
2. `retry`: one more try when the request fails to reach the API or hangs. The first try gets
   half of the budget.

- MotionTools refuses a client version it no longer knows with HTTP 400 `unknown_tenant`, or
  one too old with HTTP 410. The adapter then reads the version the page sends now from the
  tenant settings at `/api/config?origin=https://booking.fastdrop.mt`, keeps it and asks
  again.
- An unknown number is HTTP 404 with `error_code` `not_found`, which the page reports as a
  tracking ID it cannot find. A 404 without it, another 400 or a redirect is a moved route.
- MotionTools answers a few quick lookups from one address with HTTP 429 `Retry later`.
- The reply's `tracking_code` must be the number asked.
- Recognition makes the same request.

## Notes

- Each resolved stop becomes an event worded as the page words it: a pickup or a drop-off,
  at a hub or not, that went through or failed. A failed stop carries the reason the
  operator chose, which the adapter appends without phone numbers. Stops still to come have
  no outcome and are skipped.
- A stop's `resolved_at` is an ISO 8601 date-time with its offset, so the events are
  instants. A clock without an offset would stay `local_time`.
- The package status, which can be newer than any stop, sets the headline. A `failed`
  package takes the failed stop's stage: a missed delivery is a failed attempt, a missed
  pickup an exception. A package waiting for its next leg after a stop is in transit.
- A collection at the hub ends the journey without a stop, so it has no delivery time.
- The delivery estimate is kept while the parcel is on its way. The pickup and destination
  coordinates, which the platform blurs, the driver's position and the short alias of the
  tracking code are not kept. The reply names no sender, recipient or driver.

## Limitations

- No scan location, service, weight or proof of delivery.
- The short alias the platform gives each package does not find it here.

## Numbers

Tracking IDs are ten digits, often with leading zeros. Ten bare digits are shared with other
carriers, so no rule claims them. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`booking.fastdrop.mt/package-tracking/{number}` opens one parcel. The search page at
tracking.fastdrop.mt builds that address.

## Testing

`npm run test:carriers:live -- carriers/fastdrop`, with `FASTDROP_TRACKING_NUMBER` and
optionally `FASTDROP_UNKNOWN_NUMBER` set outside the repository.
