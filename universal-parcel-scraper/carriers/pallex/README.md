# Pall-Ex

Pall-Ex parcels use enabled universal providers. There is no dedicated adapter.

Pall-Ex (Pallex) is a British palletised-freight network of member hauliers, with partner hubs
across Europe. Its site is pallex.co.uk.

## Numbers

A pallet is tracked by the first sixteen digits of its barcode, a length many carriers share,
so there is no rule.

## Why there is no adapter

Its tracker at mynexus.pallex.com asks for the delivery postcode with the barcode.

## Links

The tracker's own result addresses carry the barcode and the postcode as path segments; the
library reads the barcode from them. The catalog sends people to the search page, since an address
would need the postcode.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
