# Ninja Van

Reads country-bearing parcel IDs through the anonymous country clients used by
[Ninja Van's public tracker](https://www.ninjavan.co/en-sg/tracking) and
[Ninja Xpress](https://www.ninjaxpress.co/en-id/tracking). The identifier selects
the request country, not the parcel's destination or service level.

## Retrieval

The shared official client sends one bounded GET to
`https://walrus.ninjavan.co/{country}/dash/1.2/public/orders` with `tracking_id`.
The response must echo the whole requested ID, and every scan must belong to
that order. HTTP recognition uses the same lookup and checks.

A 404 establishes absence only when its structured error echoes that ID as
not found. Retained orders whose details are unavailable, empty histories and
other tracking errors remain inconclusive. Custom shipper IDs without a known
country and stamp IDs require a different route or identity binding.

The regional routes share the public page's request and response handling.
Usable public history has been established for Malaysia; the other routes do
not have a retained public positive. Vietnam's route supports retained tracking
compatibility: its [official notice](https://www.ninjavan.co/vi-vn) says Express
Logistics has ceased, while other logistics services continue.

## Parsing

The page hides internal routing and bookkeeping events. Its oldest-first feed
is reversed after those rows are checked and removed. Explicit scan offsets
are preserved; unresolved clocks retain provider text. An explicit return scan
starts the return leg, and a return-marked delivery scan completes it. Bounded
history is marked incomplete. Merchant information, recipient details and
delivery proof are excluded.

The delivery window is read as the public page reads it: days in the route's
country, only while the order is moving towards the recipient and has a
timeslot. The server moves an overdue window's start up to the day of the
lookup, so a start after the end gives no estimate, and a window that ended
before the newest scan is dropped as stale. On the Singapore, Malaysia,
Philippines, Thailand and Vietnam routes, a one-day window takes its timeslot's
clocks in the route's country, `09 AM to 12 PM` as 09:00 to 12:00. Indonesia
spans three zones and the reply names no destination region, so its one-day
window stays a day. A window of several days stays days, since its timeslot
recurs each day. A timeslot that is not two whole hours in order, or that ended
before the newest scan, leaves the day. The reply names no destination country,
so the clocks assume the parcel is delivered under its route's clock, as the
public page reads the window; a cross-border parcel delivered in a country an
hour apart from its route would read an hour off.

## Live test

Set `NINJA_VAN_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/ninja-van/adapter.live.test.ts`.
`NINJA_VAN_UNKNOWN_NUMBER` checks explicit absence. Regional inputs use
`NINJA_VAN_{COUNTRY}_TRACKING_NUMBER` and `NINJA_VAN_{COUNTRY}_UNKNOWN_NUMBER`,
with the country in uppercase. `NINJA_VAN_INDETERMINATE_NUMBER` checks unavailable
retained history without treating it as absence.
