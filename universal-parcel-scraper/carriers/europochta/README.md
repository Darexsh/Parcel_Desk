# Europochta

The native adapter reads Europochta's public parcel history in Belarus. The catalogue's
number rule stays limited to its own labels; UPU labels ending in BY belong to postal detection.

## Retrieval

The public page's `globalRoutes.getTracking` names `GET /mvc/application/ops/tracking/?number=…`.
It returns JSON despite its HTML content type and needs no account. The whole single-number
request binds the response; any shipment number in a notification must agree with it.

The adapter tries HTTP first and retries a failed connection once. An identified browser check
can recover through TRAWL at the exact lookup URL. That path reads the final response bytes,
since browser HTML parsing can change JSON containing markup. HTTP recognition stays HTTP-only.

The history keeps the carrier's local wall clocks. Internal employee fields and hidden
administrative notices are ignored. Collection notifications keep their milestone without the
office address or collection terms; identical scans are kept once. Arrival notifications sent
after collection establish no new movement and are omitted.

## Limitations

The lookup's generic `Failed to fetch data` reply can also mean a failed upstream read. It stays
inconclusive, as does an empty history. A missing route is a transport failure.

## Testing

Use private inputs outside Git:

```sh
EUROPOCHTA_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/europochta
FLARESOLVERR_URL=… EUROPOCHTA_TRACKING_NUMBER=… npm run test:carriers:live -- carriers/europochta
```
