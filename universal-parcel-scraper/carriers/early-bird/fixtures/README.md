# Fixtures

`door.json`, `locker.json` and `legacy.json` follow the shape of the tracking service's
`timeline` reply: the current status, the scans newest first with their wording and clock, no
action and a request id. `door.json` and `locker.json` carry UTC instants; `legacy.json` is a
parcel from the earlier system, in Swedish with wall clocks. `handover.json` is an
`external_link` reply, whose shape and allowed link origins come from the tracking page's code;
its wording and link are invented. `not-found.json` and `invalid.json` are the error replies for
an unknown number and a refused one. Numbers, places, clocks and request ids are invented.
