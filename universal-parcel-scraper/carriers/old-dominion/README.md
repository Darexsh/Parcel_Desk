# Old Dominion

LTL freight history for Old Dominion PRO numbers of 9 to 11 digits, read from the public trace
page. Automatic tracking uses a fresh local Chromium configured by `TRACKING_CHROMIUM_PATH`; no
credential is needed. Truckload Services PROs (`600` once leading zeros are dropped) are rejected
before any request: the trace page shows their history only after delivery and otherwise refers
to Truckload Services. So are the PROs the page refuses to send: one repeated digit, a run of its
placeholder sequence, or any PRO containing `123456789`.

## Retrieval

The browser opens `https://www.odfl.com/us/en/tools/trace-track-ltl-freight.html?proNumbers=<PRO>`.
On load the page obtains its own reCAPTCHA Enterprise token and posts
`{"referenceType":"PRO","referenceNumbers":[<PRO>]}` to
`https://api.odfl.com/tracking/v3.0/shipment.track`, which streams one JSON line per PRO. The
adapter observes that call before navigating and reads its reply; the token and headers stay in
the browser. The page sends the PRO without leading zeros. A call for any other reference fails
the lookup.

The reply must name the PRO twice: `body.referenceType` is `PRO` and `body.referenceNumber` is the
PRO, and the single `traceInfo` entry carries the same `proNumber`. The page neither repeats nor
re-verifies the call, so its first reply is the answer.

Launch, queueing and retrieval share the caller's deadline, capped at the shared browser's
60 seconds. The page answers within seconds, so loading it is capped at 15 seconds and waiting
for its call at 25: a page that never loads or never calls, for instance because its reCAPTCHA
script is blocked, releases the shared browser early. Part of the deadline is kept to close the
context, and the browser closes after each lookup. The launch flag and the Chrome User-Agent
built from the installed version are scoped to this adapter.

## Notes

- `trackTraceDetail[].status` drives the stage; `statusDesc` names the service center for
  movements ("Arrived at CITY, ST (ABC)"). Appointment, delay and returned-to-dock statuses stay
  in transit, `Agent Handoff` is out for delivery and `Received At Dock` stands in for the
  pickup, as on the page's progress rail. The rail lights nothing for `Pickup Confirmed`, as for
  `Pickup Requested`, so both are registered. It lights nothing for `Arrived at Consignee`
  either: that status comes at the consignee's site between `Out for Delivery` and `Delivered`
  and is filed with `Out for Delivery`. `Appointment Attempted` is about booking the delivery,
  not a delivery attempt, and the shared wording rules would read `Returned To Dock` as a return
  to the shipper.
- Service-center movements (`In Transit`), `Pickup Requested` and `Out for Delivery` keep the
  service center's city as the location. Every other status carries none, including those at the
  shipper's or consignee's own site (`Pickup Completed`, `Arrived at Consignee`, `Delivered`,
  `Delivery Confirmed`), whose city is the customer's.
- `Delivery Confirmed` follows `Delivered`. The latest scan sets the status; the `Delivered` scan
  sets `delivered_at`.
- Scan clocks carry their UTC offset and keep it as instants: the trace page itself converts
  each one to the viewer's zone. The live history seen gives every scan `-04:00`, whatever the
  service center's zone. Weight is converted from pounds.
- Until delivery, `expected_delivery` is the confirmed delivery appointment
  (`deliveryAppointmentStatus` `Appointment Set/Confirmed`) that the page shows as "Appointment
  Scheduled": the start's day with its window, or with a single time when the start is
  midnight, which the page drops, or equals the end. Its ends have no offset, so it stays on the
  service's own clock, as text: `YYYY-MM-DD HH:mm–HH:mm` when the window lies within that day and
  starts before it ends, else the day alone. Without such an appointment, or when its start is
  no wall clock, the estimate (`updatedEta`, else `standardEta`) gives a calendar day. The
  pickup appointment is never read, since its window can end before it starts.
- Shipper and consignee names and addresses, the signer, bill of lading and purchase order
  numbers and piece count are discarded.
- An empty `500` is a rejected page verification, and the `422` "couldn't confirm you're not a
  robot" envelope is a challenge. Only `shipment_not_found` for this PRO is not found. A `404`
  or `410` from the page or the service says nothing about the shipment.

## Limitations

The tracking service takes a single-use reCAPTCHA Enterprise token with each call and scores it,
so there is no plain HTTP route: a missing, junk or replayed token gets the empty `500`. The
adapter lets the page obtain its own token and never makes or replays one. A low score ends the
lookup as a challenge, which enabled universal providers can take over; the score depends on the
browser build and the network. The page uses [score-based verification](https://docs.cloud.google.com/recaptcha/docs/instrument-web-pages),
which has no interactive puzzle to solve manually. Each action generates a fresh token that
must be assessed within two minutes. Retaining an accepted browser profile can preserve context
for future scoring, but does not create a reusable verification token. The adapter uses fresh
contexts. Each lookup takes a turn in the process's one local Chromium, a
few seconds when the page answers, so other browser lookups queue behind it. The account tracking
API (`v2.0`) requires an ODFL.com login. The former `OD4mobile` app is discontinued, and no
current app (no `com.odfl.*` package) offers another public route.

Eleven-digit PROs starting with `80` are only suggested, not claimed: DPD Romania's waybills
start the same way and pass the same check digit about one time in ten.

## Testing

Set `TRACKING_CHROMIUM_PATH` and `OLD_DOMINION_TRACKING_NUMBER` outside the repository, then run
`npm run test:carriers:live -- carriers/old-dominion`. A lookup the page's reCAPTCHA refuses skips
its test: a challenge proves neither breakage nor health.
