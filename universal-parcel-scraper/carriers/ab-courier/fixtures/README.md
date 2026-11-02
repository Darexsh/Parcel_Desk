# Fixtures

`delivered.json`, `in-transit.json` and `not-found.json` follow the reply of
`ABWebclientAPI/V1/Auth/TrackingInfo`, the lookup the tracking page makes: the envelope's status
code and answer, the order's summary (`trackingDtl`) with its status, pickup and delivery towns,
service, clocks, estimate, weight, signer and driver, the boxes, and the status picture with its
step and wording.

`delivered.json` is a two-box order delivered the day it was picked up, within Ontario, with the
signer the page shows. `in-transit.json` is an envelope on its way overnight after its pickup,
whose picture words the status as "In Transit". `not-found.json` is the answer for an order the
tracker does not have.

Order numbers, people's names, towns, clocks, weights and driver numbers are invented.
