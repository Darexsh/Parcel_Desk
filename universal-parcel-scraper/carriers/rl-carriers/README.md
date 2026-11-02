# R+L Carriers

Tracks R+L Carriers LTL freight shipments by PRO number through R+L's own shipment tracing page.

## How it works

The tracing form on `www.rlcarriers.com` posts the PRO number to
`https://www.rlcarriers.com/freight/shipping/shipment-tracing?pro={number}&docType=PRO&source=web`
as `Type=PRO&TrackingNumbers={number}`. No account, token, anti-forgery field or CAPTCHA is needed.
The adapter sends that same request. The result page carries its shipments as JSON in a hidden
`shipment_list` field. Each entry holds a summary, the shipment's dates, pieces and weight, and
its history, oldest first. When R+L has no record of a PRO, the entry carries an error that names
it, and that error is the only reply read as not found.

R+L checks a PRO's check digit before it looks the shipment up. When the check fails, the search
redirects back to the search page and stores its message in a new ASP.NET session. The adapter
opens that page with the session cookie alone. A failed check digit is invalid input. Any other
message, a redirect elsewhere, or one without a session stays inconclusive. The session request's
failures leave out the request details, which hold the cookie. A request that fails to reach R+L
is sent once more within the budget. Rate limits, the firewall's rejection page, which arrives
with HTTP 200, and other HTTP errors keep their own failure kinds. Recognition uses the same
lookup.

## Numbers

A PRO number is nine digits, or two letters and seven digits. The last digit is a check digit,
which R+L checks and the library does not. PRO numbers are often written with the check digit
after a dash. The tracer names every PRO with an `I` in front, on its result page too, and takes
that form as well; the library drops the `I`. `rl-carriers-1` offers R+L for the dashed form and
`rl-carriers-2` for nine digits after the `I`, both at low confidence, so preflight asks
recognition. Other carriers share both layouts without the dash or the `I`, so neither is claimed
then. Three letters and seven digits are a shape other carriers' references take, so an `I`
before two letters and seven digits is not claimed either.

## Notes

- The tracer can answer a PRO with the shipment of another PRO, without a notice. The result then
  names that PRO as the canonical tracking number, and recognition leaves the number undecided.
- Row clocks have no offset and are kept as local times. Which zone the history uses is not known.
  The page lists rows oldest first; the result reverses that order and keeps identical rows once.
- Rows are mapped by their wording in [status.ts](status.ts). A delay keeps the shipment in
  transit, as the page does. When the summary's status is further along than the rows, the
  summary decides.
- A pickup row names the shipper's town, so it is kept as `Picked Up` without a location.
  Departures are located at the terminal they leave, and arrivals at the terminal they reach.
- The estimated delivery day is midnight on the East Coast. It is kept until the shipment is
  delivered. The weight is in pounds and is converted to kilograms.
- The entry also lists the shipper, consignee and bill-to party with their addresses, the bill of
  lading number, the piece count and the shipment's documents. None of them is read.

## Limitations

R+L's tracer no longer knows older shipments, which come back like unknown ones. Its account APIs
are out of scope.

## Links

R+L's tracing form sends a PRO number to
`rlcarriers.com/freight/shipping/shipment-tracing?pro={number}&docType=PRO&source=web`.

## Live test

Set `RL_CARRIERS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/rl-carriers/adapter.live.test.ts`.
Optionally set `RL_CARRIERS_UNKNOWN_NUMBER` to check a PRO R+L has no record of.
