# Fixtures

`verification.json` is the id Quick Track's verification request returns. `delivered.json` and
`in-transit.json` follow the reply of its `quickTrackpublic` lookup: the consignment's summary,
the sender's and receiver's localities, the signatory and the status rows, newest first, each
with the scans of the units behind it. `delivered.json` is a plain eight-digit consignment of
two units on customer barcodes, from the sender's draft to the delivery, with an undated pickup
step and a signatory. `in-transit.json` is a sender-prefix consignment of two units on Border
Express labels, sent from Queensland, whose clock keeps standard time in summer, to New South
Wales. `not-found.json` is the problem reply for a consignment the tracker does not know.

Numbers, ids, names, places and clocks are invented.
