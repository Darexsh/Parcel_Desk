# Fixtures

`dpd-at-warehouse.json` and `dhl-relayed.json` follow the reply of the tracking page's
`listTrackInfos` lookup in English. The first is an order bound for Germany that 17FEIA's
warehouse holds, with its DPD Germany number. The second is an order bound for France that
DHL carries on: the estimate, flight and customs milestones with a destination's offset and no
country, a repeated row, and DHL's scans relayed with their country and offset.
`fedex-relayed.json` is an order delivered in the United States: the milestones with US Central's
standard offset, and FedEx's scans relayed with their state and offset, among them a state with
two clocks and a pickup at midnight under another state's offset. `not-found.json` is the answer
for an unknown order.

Numbers, ids, places, postcodes, weights and clocks are invented.
