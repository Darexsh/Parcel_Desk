# The Human Express

The Human Express parcels use enabled universal providers. There is no dedicated adapter.

The Human Express, run by The Human Company Limited in Hanoi, ships online sellers' parcels from
Vietnam to the United States, including TikTok Shop orders and stock for Amazon's warehouses, and
USPS delivers them there. Its site is thehuman.express.

## Numbers

Its API documentation gives package codes as THE and sixteen digits, made of the customer's id and
the package's id, often followed by SB. The examples come from one source and share their digits
with [Greenway](../greenway-vn/README.md)'s, which runs on the same platform, so
`the-human-express-1` suggests The Human Express at low confidence. Parcels also carry a USPS
number, which the USPS rules read.

## Why there is no adapter

The tracking page asks an open JSON service without a login or CAPTCHA, which takes up to 40 codes
at once and answers an unknown one as not found. No public code has shown a known parcel's reply
yet. An adapter for this platform could serve Greenway too.

## Links

Tracking links carry the code as `trackings` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
