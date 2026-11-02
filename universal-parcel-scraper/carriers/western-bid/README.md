# Western Bid

Western Bid and WestParcel consolidate cross-border parcels and hand them to delivery partners.
Enabled universal providers supply tracking; there is no dedicated adapter.

## Retrieval

The official whole-number link executes reCAPTCHA Enterprise for action `TRACK`, then asks
`trackservice.wbapi.systems/api/track/currentStatus` with `trackingNumber` and a
`Recaptcha-Token` header. A public result identifies its own WBX shipment and related delivery
numbers. Some related values are complete USPS routing barcodes; their validated package
identifier can identify the same parcel without treating an arbitrary suffix as an alias.
The optional public details view contains additional history.

## Limitations

The cached browser path can stop at a generic form error before issuing the tracking request.
That error proves neither existence nor absence. A native adapter needs reliable guest
verification and a bound result across this path; opening the page alone is insufficient.

## Testing

Provider live-test inputs and commands are in the [provider READMEs](../../providers/README.md).
