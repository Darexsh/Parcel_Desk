# Airspeed

Airspeed parcels use enabled universal providers. There is no dedicated adapter.

Airspeed (Airspeed International Corporation) is a Philippine courier, cargo forwarder and logistics group,
delivering across the Philippines and forwarding shipments abroad. Its site is airspeed.ph.

## Numbers

Its waybills are nine digits, as an archived lookup on its own tracker shows. Nine digits are shared by other
carriers, so there is no rule.

## Why there is no adapter

Its cargo tracker answers an open GET, `logistics.airspeed.com.ph/track/TrackingSearch.aspx` with the number in
`waybill`, without a session or CAPTCHA, and returns an HTML page with the shipment's details and scan history.
An unknown number gets the same page with empty fields and the server's current time as its booking date. The
page also names the recipient. The tracking form on trackshipment.airspeed.com.ph, linked from the home page,
does not find the public number. No adapter has been written for it yet.

## Links

The cargo tracker opens numbers from its `waybill` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
