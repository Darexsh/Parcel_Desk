# Zajel

Zajel parcels use enabled universal providers. There is no dedicated adapter.

Zajel (ZAJEL Courier Services) is a courier in the United Arab Emirates that carries parcels,
freight and on-demand deliveries within the Emirates and abroad, and delivers Emirates ID cards and
government documents. Its site is zajel.com.

## Numbers

Its tracking page's placeholder is ZAJEL and nine digits, a made-up example. No public number is
known, so there is no rule.

## Why there is no adapter

The results page asks an open JSON service without a session or CAPTCHA, which answers an unknown
number with a server error rather than not found. No public number has shown a known shipment's
reply yet.

## Links

Tracking links carry the number as `q` on the results page with `type=awb`. With `type=mobile` the
page looks up a phone number instead, which the links do not read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
