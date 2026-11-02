# Fixtures

`delivered.json` and `in-transit.json` follow the shape of the tracking service's English reply:
one entry for the number asked, with its events newest first, each with a day, a UPU event code,
its wording, the page's progress category and sometimes an office or facility. Offices,
facilities and days are invented. `delivered.json` is an item sent abroad and delivered there,
`in-transit.json` one that has just left Luxembourg. `not-found.json` is the reply for a number
without history.
