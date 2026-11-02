# AAA Cooper

AAA Cooper Transportation shipments use enabled universal providers. There is no dedicated
adapter.

## Numbers

AAA Cooper tracks less-than-truckload freight by its PRO number. Lookups archived from its own
tracking pages show eight- and nine-digit PROs. Both lengths are shared by many carriers, so no
rule claims them; a caller names the carrier or pastes a tracking page link. Pickup numbers
find a shipment on the same page and are not recorded.

## Links

AAA Cooper's Action Trac page opens one shipment at
`aaacooper.com/workspace/action-trac?id={number}&PG=ProNumber`. Older links put the PRO in
`ProNum` on `Transit/ProTrackResults.aspx`, with or without a `pwb/` prefix. The library reads
the number from each form.

## Why there is no adapter

Action Trac is a WebAssembly app that reads the shipment from its own host, and the older
`pwb/Transit/ProTrackResults.aspx?ProNum=` page still answers there. That host,
`www.aaacooper.com`, refuses connections from outside the Americas: from Europe, Asia and
Australia the connection times out before any reply, for the whole site. AAA Cooper publishes
no tracking app, so AAA Cooper stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
