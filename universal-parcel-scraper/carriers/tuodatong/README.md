# Tuodatong

Tuodatong parcels use enabled universal providers. There is no dedicated adapter.

Tuodatong (拓达通物流, Shenzhen Tuodatong International Logistics Service) is a Shenzhen
cross-border forwarder with air and sea parcel lines from China. Its site is tuodatong56.com.

## Numbers

Its tracking numbers read `TDT`, ten digits and `CN`, and its price list names its own lines
with the same `TDT` code. ParcelsApp names DHLink beside Tuodatong for one, so the rule is low
confidence and shared with [DHLink](../dhlink/README.md), the carrier recognition asks about it.

## Why there is no adapter

Its tracker is its own install of the Hualei (华磊) forwarder platform, like
[GZYL's](../gzyl/README.md), under a `/tms` base path: `GET /tms/selectTrack.htm` with a
`documentCode` parameter answers JSON in GBK without a session, over HTTPS and on plain HTTP
port 8082. The shared Hualei client drops a base path, so an adapter needs the path or the
port. No public number has been found to check the interface with.

## Links

The tracker page opens a number from its `documentCode` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
