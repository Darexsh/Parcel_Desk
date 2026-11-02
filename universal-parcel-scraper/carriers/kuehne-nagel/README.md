# Kuehne+Nagel

Tracks Kuehne+Nagel road, air and sea shipments through the anonymous services behind its
public tracker on `mykn.kuehne-nagel.com`.

## How it works

The public tracker is a Vue app that asks three JSON services on the same host. The adapter
asks them the same way:

1. `GET /public-tracking/internal/shipment-list?query={number}` searches every kind of
   reference at once and returns the shipments found, grouped by the kind the query matched,
   each with the tracker's own id.
2. `GET /public-tracking/internal/shipments/{id}/shipment-routing` returns the route: its stops
   in order, each with its milestones.
3. `GET /public-tracking/internal/shipments/{id}/information-milestones` returns the notices:
   bookings, customs steps and documents.

The route and the notices are asked together once the search has found the shipment. Road, air
and sea shipments use the same services. No account, cookie, key or browser is needed, and the
tracker has no CAPTCHA. If a request fails to reach the tracker, the whole lookup is tried once
more within the budget.

The search ignores case, spaces and dashes and matches whole references only. A shipment whose
own tracking number is the query is the answer. Otherwise the query must lead to exactly one
shipment, such as through a customer reference or a waybill; the result then names that
shipment's tracking number as `canonical_tracking_number`. Several shipments are left
undecided. No results is the only missing shipment. A block page, HTTP errors and malformed
replies keep their own failure kinds, and a missing route or notices is a transport failure.

Recognition sends only the search. A number is known when the tracker finds it under one of
Kuehne+Nagel's own references: tracking, house waybill, booking, file and shipment numbers, and
Blue Anchor Line bills. A match only under a customer reference, a package reference, a container
or another carrier's bill is left undecided, because anyone can hold those references.

The myKN app is not needed, since the web tracker answers anonymously.

## Numbers

The adapter takes references of 6 to 35 letters and digits, with at least one digit, and lets the
tracker decide what they are. Road tracking numbers made of a two-digit year, `A` and nine digits
are shared with other carriers' rules. `kuehne-nagel-1` suggests them at low confidence, so
preflight asks the tracker. `RWM` and nine digits is `kuehne-nagel-2`. Waybills and customer
references have no rule of their own.

## Notes

A milestone counts once it has an actual date. Planned dates, including the planned delivery,
are not read: road plans are set at booking and are not updated. The notices are dated events
of their own, and details within a notice become events too. An undated notice is a step still to
come and is skipped.

Each date has its own `offset` field when the scanning system knows the offset, and the event
then keeps that offset. Some scans have only a clock, and some notices only a date. Those stay as
local clocks or dates, because the `offsetDateTime` field beside them always says `+00:00`. Road
exceptions, such as a failed delivery attempt, sit on their milestone; each becomes its own event
at the date it was reported.

The status codes are the tracker's label keys without their family prefix, and the code alone
decides the stage. Descriptions come from the tracker's English messages, which also give the
whole vocabulary in `statuses.json`. A booking can be confirmed or changed after the first scans,
and a customs notice can be filed after the delivery. Neither moves a shipment back.

A stop's town comes from the tracker: a station, port or airport by its name, and a shipper's or
consignee's town as the tracker writes it. A town written with digits is replaced by its
country, since such text can hold a postcode or a street. The destination country, the weight in
kilograms and the delivery time are read. Agent addresses, the search's own origin and
destination, volumes, vehicles and remarks are not read.

## Limitations

The public tracker covers shipments started in the last 90 days, so an older one answers like an
unknown number. Most air, sea, customs and exception codes come from the tracker's messages and
have not been seen live. Port-to-port sea and air shipments end at their arrival milestones,
which stay in transit even when the tracker calls the shipment complete.

## Links

The home page's tracking field opens
`mykn.kuehne-nagel.com/public-tracking/shipments?query={number}`. The server sends a found
shipment on to `/public-tracking/shipments/{id}?query={number}`, and both addresses are read as
links.

## Live test

Set `KUEHNE_NAGEL_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/kuehne-nagel/adapter.live.test.ts`.
Optionally set `KUEHNE_NAGEL_UNKNOWN_NUMBER` to check a reference the tracker does not hold.
