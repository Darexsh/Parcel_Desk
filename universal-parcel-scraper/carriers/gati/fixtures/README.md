# Fixtures

The replies follow `admin.allcargologistics.com/api/track-shipment` for one docket: an envelope,
then one entry in `details` with the docket's own fields and its scans newest first.
`delivered.json` goes from booking to delivery, with an arrival repeated, a failed delivery
and the consignor, consignee, receiver, remarks and proof of delivery link the reply carries.
`in-transit.json` has reached its delivery branch and gives the delivery date promised at
booking. `not-found.json` is the answer for a docket the tracking service does not know.

Numbers, names, references, places, weights and clocks are invented.
