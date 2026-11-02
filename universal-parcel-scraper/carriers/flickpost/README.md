# Flickpost

Flickpost parcels use enabled universal providers. There is no dedicated adapter.

Flickpost, run by Cargo Miles Sdn Bhd, ships parcels from Malaysia to more than 200 countries, on
postal lanes or by courier. Its site is flickpost.com.

## Numbers

Flickpost hands most parcels to Pos Malaysia, so its customers mostly get Pos Malaysia's UPU S10
numbers ending in MY, which its tracker also answers. Those numbers belong to Pos Malaysia's
network, so no rule claims them for Flickpost. Its own ids, X and six digits, are too short and
common a shape for a rule.

## Why there is no adapter

The tracker reads up to forty numbers from its address and draws its answer on the server without a
session. Only the sentence "Error occurred while tracking shipment" marks an unknown number; an
"Invalid tracking number" sentence is hidden on every page. An adapter can follow.

## Links

Tracking links carry the number as `trackingNumber` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
