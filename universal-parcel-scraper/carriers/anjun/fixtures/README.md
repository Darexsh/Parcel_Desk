# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/open/website/track` for one number,
newest scan first, with the number echoed in `extra.trackNo`. `delivered.json` goes from Anjun's
warehouse in China to a delivery in Brazil: one transit scan is repeated, a failed attempt gives
its reason, the out-for-delivery note carries a phone number and an e-mail address, two scans
carry a facility's address, and the delivery carries coordinates, a courier, a proof-of-delivery
file and a note naming who took the parcel. `in-transit.json` has entered the bonded warehouse
after its flight. `not-found.json` is the answer for a number the tracker does not know, and
`service-error.json` the service's own failure.

Numbers, names, places, coordinates, addresses and clocks are invented.
