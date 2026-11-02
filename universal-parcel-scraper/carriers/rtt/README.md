# RTT

RTT parcels use enabled universal providers. There is no dedicated adapter.

RTT Group, founded in 1980, with its head office in Cape Town and a hub in Johannesburg, carries
and stores goods across South Africa for chain stores, fashion and healthcare businesses and other
companies, and runs contract logistics. Courier IT is its courier division. Its site is
rtt.co.za.

## Numbers

Its tracker takes RTT's parcel references. No public page shows one or states their layout, so
there is no rule. Courier IT waybills belong to [Courier IT](../courier-it/README.md), whose own
tracker answers them.

## Why there is no adapter

The tracker is a Blazor Server app on the same platform as Courier IT's. Its lookup runs over the
page's live connection to the server, and no separate request answers it. It says that a
reference it does not know was not found. No public reference has shown a known parcel's reply
yet.

## Links

Tracking links carry the reference as `SearchString` on `intellitrack.rtt.co.za`, which fills
the reference box and runs the lookup.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
