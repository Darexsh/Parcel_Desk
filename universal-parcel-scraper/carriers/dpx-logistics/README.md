# DPX Logistics

DPX Logistics parcels use enabled universal providers. There is no dedicated adapter.

DPX Logistics (Document Parcel Express) is a Bangkok express firm founded in 1988 that was once the DPEX
Worldwide licensee there; it is not [DPEX Worldwide](../dpex/README.md). It has no bare "DPX" alias, since
17TRACK gives that name to DPX Express, a different company.

## Numbers

Its air waybills are twelve digits, the last the first eleven modulo 7, the layout DPEX uses. The two public
ones are barcodes on its own blank sample forms. Japan Post, Yamato and Sagawa share the layout and its check,
so there is no rule.

## Why there is no adapter

Its tracking page posts the numbers to an open JSON endpoint without a session or CAPTCHA:
`POST trackingapi.dpxlogistics.com/track` with `{"connotes": [...]}`. Some shipments come back as sent by DHL
or FedEx, with that carrier's number. An unknown number gets an empty history, and no public number is known
to see a found reply.

## Links

The tracking page reads the number from its fragment.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
