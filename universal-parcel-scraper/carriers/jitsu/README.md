# Jitsu

Tracks Jitsu parcels, formerly AxleHire's, in the United States through the service behind
Jitsu's own tracker.

## How it works

Jitsu's tracker at `tracking.gojitsu.com` and its recipient app at `recipient.gojitsu.com` are
the same single-page app. It asks `api.recipient.gojitsu.com/delivery/{code}` for the delivery,
without a cookie or token, and so does the adapter: one GET that does not follow redirects. No
account, key, CAPTCHA or browser is needed. A request that fails to reach Jitsu is sent once more
within the budget.

A known code gets the shipment as JSON: its events, delivery window and clock, and the tracker's
settings. An unknown code gets HTTP 404 with the service's own body naming the path asked, which
is the only missing shipment. Any other 404 or 410, a redirect, or a reply about another code
stays inconclusive. A browser challenge, rate limits and other HTTP errors keep their own failure
kinds. Recognition uses the same lookup.

## Numbers

Jitsu's own codes are twelve or sixteen letters and digits, and it also tracks some shippers'
numbers, such as nineteen-character ones starting `SCD`. The service matches them in any case.
Jitsu publishes no layout for any of them and they overlap other carriers' shapes, so detection
offers no Jitsu rule and recognition is not asked for them; Jitsu tracking runs when the caller
names the carrier. Anything but four to forty letters and digits is invalid without a request.

## Notes

- Each event's provider code is its type and signal, such as `OUTBOUND.DROPOFF_SUCCEEDED`, the
  key of the tracker's own wording templates. Codes are mapped in [status.ts](status.ts); others go
  to the shared wording rules. The tracker's milestone is not used for the stage: it shows a failed
  attempt as in transit and a round still at the facility as out for delivery.
- A route "pickup" is the driver collecting the parcel at Jitsu's facility, and a "return" the
  driver bringing it back there after a failed attempt. A new plan after the parcel has moved,
  delay and waiting notices, and recycling-bag collections move nothing.
- Events are read as the tracker lists them: newest first, without the recipient's address
  changes and without a facility's first scan within a minute of its receipt scan. Clocks carry
  their offset and are given on the shipment's own clock.
- Facility and partner-carrier scans carry the town and state the tracker prints under them.
- The delivery window is shown while the parcel is on its way and the window has not ended
  before the newest scan. As on the tracker, a late round moves it to the same hours on the next
  service day, and a shipper can hide it until Jitsu has the parcel.
- The reply also carries the recipient's masked contact details, town and postcode, the stops'
  remarks, the driver's remarks and vehicle, access codes, the merchant and the linehaul
  carrier's ids. None of them is read, nor are the photos and signatures the recipient app shows
  after a check of the recipient's details.

## Links

Jitsu's tracker opens a parcel at `recipient.gojitsu.com/{code}` or `tracking.gojitsu.com/{code}`;
the former AxleHire hosts `recipient.axlehire.com` and `tracking.axlehire.com` forward there,
and the library reads the number from all four. The link it builds uses `/noredirect/{code}`,
where an unknown code shows the tracker's not-found page instead of an empty search.

## Live test

Set `JITSU_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/jitsu/adapter.live.test.ts`.
Optionally set `JITSU_UNKNOWN_NUMBER` to check a code Jitsu does not know.
