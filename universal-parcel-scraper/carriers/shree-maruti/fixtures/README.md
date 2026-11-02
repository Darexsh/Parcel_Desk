# Fixtures

Each file is a reply of `tracking/v2/{number}`. `delivered.json` is a courier docket's history,
newest first: a delivery copied in weeks later at the courier's wall clock beside the live
delivery, a hidden bookkeeping row, an out-for-delivery row with the delivery agent's details,
hub scans with the placeholder location `default`, two rows at one moment, and a dispatch row
whose location is the sender's address. Its order carries the recipient's and sender's names,
phones and addresses, the delivery agent and proof-of-delivery links, which the tracker never
shows. `in-transit.json` is a parcel between hubs whose newest row names the docket only in the
hub system's number field. `not-found.json` is the answer for a number the service does not know.

Numbers, names, phones, addresses, places, links and clocks are invented.
