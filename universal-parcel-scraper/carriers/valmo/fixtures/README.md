# Fixtures

`delivered.json`, `in-transit.json` and `returned.json` follow the reply of the track page's
`/api/valmo-web/track-order`: the steps in order with the hub scans under each, the progress rail
the page draws over them and the summary status. `delivered.json` goes from an order confirmed
twice to the delivery, through a failed attempt; one hub scan is repeated and the first step's
instant has milliseconds. `in-transit.json` waits at a hub, with the steps not reached yet greyed
out. `returned.json` fails delivery and goes back to the seller, while its summary still shows
the failure. `not-found.json` is the answer for a tracking ID the tracker has no parcel for.

Tracking IDs, request IDs, hubs and instants are invented.
