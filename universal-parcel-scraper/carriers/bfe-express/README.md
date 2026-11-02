# BFE Express

BFE Express parcels use enabled universal providers. There is no dedicated adapter.

BFE Express delivers the last mile of online orders, many from marketplaces abroad, in Argentina,
Peru, Uruguay and the United States. Its site is bfeexpress.com.

## Numbers

Its contact form checks numbers by country: CK, the country's calling code and twelve or thirteen
digits in Peru, Uruguay and Argentina, WYB and nine digits in Peru, and two nineteen-digit series
in Argentina. No public number has been found to test them with, so there is no rule.

## Why there is no adapter

The tracking page encrypts the numbers it sends to an open JSON service with a key in its script.
No public number has shown a known parcel's reply yet. An adapter can follow.

## Links

Tracking links carry the number as `track_number` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
