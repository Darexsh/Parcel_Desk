# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracking service's `/info` for one
number, newest scan first, with the summary fields the page reads. `delivered.json` goes from
the sender's preparation to the delivery, in winter time: one branch scan is repeated, a failed
attempt with a notice follows the courier's scan with its delivery window, and the delivery
carries a signature and a sender's reference. `in-transit.json` waits at the delivering branch,
in summer time. `invalid-number.json` is the service's HTTP 400 answer for a number it does not
accept. An unknown number is an empty HTTP 204, so it has no fixture.

Numbers, references, depots, names and clocks are invented.
