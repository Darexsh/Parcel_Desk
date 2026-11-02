# Fixtures

`delivered.json`, `in-transit.json`, `delivery-failed.json` and `no-history.json` follow the
reply of `/web_app/delivery/track/{awb}/`: the order's summary and the scans of its current
milestone, newest first. `delivered.json` carries a masked phone number and a delivery
remark, which the adapter drops. `in-transit.json` moves between two facilities, with a bag
scan and a clock with a fraction. `delivery-failed.json` is a parcel on its way back to the
seller. `no-history.json` is a record Shadowfax knows without scans.

`not-found.json` is the delivery service's answer for a number it has no delivery request
under. `lookup-not-found.json` and `lookup-connect.json` follow the tracker's own lookup,
`/awb/awb_to_unique_code/`, for a number Shadowfax does not know and for a Shadowfax Connect
order.

Numbers, codes, places, people and clocks are invented.
