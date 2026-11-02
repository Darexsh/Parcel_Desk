# Fixtures

`delivered.json`, `ready.json`, `returned.json` and `handover.json` follow the shape of the
tracking service's reply: scans newest first with their milestone, leg, English wording and UTC
clock, the pickup point's address and id on some scans, and the page's banner, pickup deadline
and questions. Ids, names, places, addresses and clocks are invented, and so is the handover
scan's wording, which no reply showed. `expired.json` is the service's fixed answer for a number
over six months old.
