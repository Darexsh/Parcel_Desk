# Citi-Sprint

Citi-Sprint parcels use enabled universal providers. There is no dedicated adapter.

Citi-Sprint (Citi-Sprint Express Courier Services) is a Cape Town courier for same-day deliveries in the city
and national deliveries across South Africa. Its site is citisprint.co.za.

## Numbers

Its portal's waybill references open with a three-character prefix that each client account sets, followed by
the platform's reference, so no prefix points to Citi-Sprint. Its older paper waybills carry six pre-printed
digits, as the blank form on its waybills page shows. Neither layout is Citi-Sprint's alone, so there is no
rule.

## Why there is no adapter

Its portal runs on Ship Logic, the platform Internet Express's and The Courier Guy's adapters read, on its own
API host: `GET api.portal.citisprint.co.za/tracking/shipments` with the reference in `tracking_reference` and
Citi-Sprint's Ship Logic provider id, `39`, in `provider_id`. It needs no cookie, token or key, and answers an
unknown reference with HTTP 404 and the plain text `could not find shipment or parcel with reference {number}`.
The tracking page on citisprint.co.za reads the same data through a WordPress proxy that answers an unknown
number with HTTP 502, so the API host is the better source. No public number is known to see a found reply.

## Links

The portal opens one shipment at `portal.citisprint.co.za/track?ref={number}`, and the site's tracking page at
`/tracking/?ref={number}`; the number is read from both.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
