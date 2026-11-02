# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the history lookup: the summary in
`eventPrediction`, with a masked recipient, and the scans oldest first, each with its status and
scan codes, its town and its wall clock with the offset in `timeZone`. `delivered.json` is a
domestic parcel that goes through a failed delivery to a delivery, then the cash on delivery
paid out to the sender. `in-transit.json` is a parcel from abroad that has cleared customs and
reached the delivery centre. `not-found.json` is the HTTP 400 answer for a number the service
does not know.

Numbers, recipients, towns and clocks are invented.
