# Veho

Veho parcels use enabled universal providers. There is no dedicated adapter.

Veho is a last-mile network in the United States that delivers e-commerce parcels for retailers
and shipping platforms. Its site is shipveho.com.

## Numbers

A Veho tracking id is `VH` and twelve letters or digits, as its API documentation and tracker
describe; `veho-1` suggests Veho for it. The tracker also takes the barcode on a sender's label
and finds the package's tracking id: one public barcode, `VEHO`, a three-letter facility code
and nine digits, gives `veho-2`. Both stay low, as no public page shows a VH tracking id. Older
tracking ids have six characters and no rule.

## Why there is no adapter

The tracker's GraphQL interface needs a Firebase App Check token that the page mints in the
browser after an invisible reCAPTCHA Enterprise check; a request without one is refused.

## Links

The tracker opens one package from `#/trackingid/<id>`, `#/barcode/<barcode>` or
`?trackingId=<id>`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
