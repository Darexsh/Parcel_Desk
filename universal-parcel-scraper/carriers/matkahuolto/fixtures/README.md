# Fixtures

`collected.json` and `waiting.json` follow the shape of the tracking service's reply: the
consignment number, references, departure station, service, extra services, pickup deadline
and scans newest first, each with a date, a time, a place, an office code, coordinates and
English wording. `collected.json` was collected from a pickup point, `waiting.json` waits at a
parcel locker. Numbers, references, places and clocks are invented. `not-found.json` is the
reply for a number the service does not know.
