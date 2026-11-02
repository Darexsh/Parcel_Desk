# ShipX

ShipX parcels use enabled universal providers. There is no dedicated adapter.

ShipX, formerly SG LINK, is the cross-border shipping platform of SGLINK Import Export JSC, a Ho Chi Minh City
company. It consolidates online sellers' parcels from Vietnam, Singapore and Malaysia and sends them to more
than 200 countries through partner carriers such as DHL, FedEx, UPS, bpost, SingPost and USPS. Its site is
shipx.asia; sglink.vn redirects there. InPost's ShipX API is unrelated.

## Numbers

A parcel usually travels under its partner carrier's number, which belongs to that carrier. ShipX's own IDs are
`SX`, nine digits and `VN` in the tracking page's example, an S10-like layout; the example fails the S10 check
digit and the tracker does not find it. No public page shows a real ShipX ID, so there is no rule. An ID whose
S10 check digit happened to validate would read as postal mail.

## Why there is no adapter

Its tracking page reads an open JSON endpoint without a session or CAPTCHA: `GET shipx.asia/api/track/{number}`,
with spaces removed and letters upper-cased, five to fifty characters. It takes a ShipX ID, a partner
carrier's number or the seller's order reference. It answers an unknown number with HTTP 404 and the error
"Failed to fetch tracking information.", wording that also fits a failed lookup at a partner, so an adapter
could not tell a missing parcel from an outage. No public number is known to see a found reply.

## Links

The tracking page fills its field from its `trackingNumber` parameter, also under its `/vi/`, `/th/`, `/id/`
and `/ms/` language paths; the visitor still presses Track.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
