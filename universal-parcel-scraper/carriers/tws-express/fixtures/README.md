# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/extracking/trackingStatusLdv`, each
leg's scans oldest first, with the empty parcel record the reply ends with. `delivered.json`
has two legs: the waybill, whose rounds fail and end on a scan with no outcome, then its `/1`
leg, where the parcel is held, released online and delivered. Two scans share a clock, one
scan is repeated, and the reply carries a sender's references, branch codes, a note and the
signer's name. `in-transit.json` waits at the hub after its waybill was created and confirmed.
`not-found.json` is the answer for a waybill the tracker does not have.

Numbers, references, names, branch codes and clocks are invented.
