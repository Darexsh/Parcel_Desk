# Fixtures

Each file follows the reply of PCP Express's `apps/RequestTracking.php` for one AWB: a shipment
whose header names the service, the sender, the recipient and the AWB, and its scans newest
first, each with the AWB, a wall clock, the branch, a status id and name, the town, a note and
the receiver and courier fields. `delivered.json` goes from a sorting facility through a
repeated manifest scan and a failed delivery with its reason to the delivery, with run sheet
assignments and the receiver's name. `in-transit.json` has reached the destination branch, on
a scan without its town. `not-found.json` is the answer for a number PCP Express has no
shipment for.

Numbers, names, branches, towns, notes and clocks are invented.
