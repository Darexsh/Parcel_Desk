# ShipGlobal US

ShipGlobal US parcels use enabled universal providers. There is no dedicated adapter.

ShipGlobal US Inc., formerly First Flight USA, sends documents and parcels from New York to more
than 220 countries and resells UPS, FedEx and USPS labels within the United States. It is a separate
company from ShipGlobal India. Its site is shipglobal.us.

## Numbers

Its waybill numbers are FFUSA and digits: seven in the tracker's example, six in the one public
number. `shipglobal-us-1` reads FFUSA and six or seven digits at low confidence, as only one public
number is known, and lists ShipGlobal US first, as the prefix is its own.

## Why there is no adapter

The tracker posts waybills to an open JSON service without a session or CAPTCHA, which answers with
the shipment's scans; their times carry no zone. An unknown and a malformed number get the same
reply. One public number is known. An adapter can follow.

## Links

Tracking links carry the waybill as `waybill` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
