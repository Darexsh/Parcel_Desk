# Fixtures

`delivered.json`, `pickup.json`, `postnord.json` and `summary.json` follow the shape of the
tracking service's reply to the adapter's query: the parcel's numbers, state and PostNord flag,
its scans, each with a state, an event code, a clock with its offset, a terminal and Norwegian
wording, and the shop and pickup point by name. Numbers, names, places and clocks are invented,
and so are the event codes and wording of the pickup scans. `not-found.json` is the reply for a
number the service does not know.
