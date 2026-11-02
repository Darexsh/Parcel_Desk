# Fixtures

The fixtures follow the tracking service's reply, newest scan first, with the summary fields and
the per-scan office contacts and coordinates it sends. `returned.json` is an act that misses its
recipient, waits at the office, is served there, reaches the end of its storage period, which
the service dates by its day alone, and goes back to the sender. `in-transit.json` is out for
delivery; its arrival scan is repeated and its first scan falls just after midnight in Rome, on
the previous day in UTC. `delivered.json` ends in a delivery whose status code is invented,
since no delivered reply was seen; it carries the family and wording the service uses for one.
`not-found.json` is the answer for a code Sailpost does not know.

Codes, offices, contacts, coordinates and clocks are invented.
