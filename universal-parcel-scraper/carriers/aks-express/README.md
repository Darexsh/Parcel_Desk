# AKS Express Kurir

AKS Express Kurir parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

AKS shipment numbers are ten digits, as an archived reply of AKS's own tracking API shows.
Many carriers print ten digits, so no rule claims them.

## Links

Both tracking forms post the number, and AKS's pages build no address that opens one parcel.

## Why there is no adapter

Both tracking forms on aks.rs send the number with a reCAPTCHA answer, and the site makes no
lookup a visitor can repeat without one. AKS has no tracking app. So AKS Express Kurir stays on
universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
