# Fixtures

Both files follow the reply of `/api/v1/starex/packages/{number}/history` in English: the
parcel's scans newest first, each with its status code, the tracking page's title and sentence
for it, an icon and a `DD-MM-YYYY HH:mm` clock, then the package's flags and the recipient's
masked details, which the adapter does not read.

- `delivered.json` is a parcel from Starex's warehouse abroad through customs, collected at a
  branch. Two scans share a clock.
- `in-transit.json` is a parcel the customer confirmed and declared, held at customs until the
  declaration came, now on its way to the pickup point.

A number the tracker does not know, a refused request and the other failures are built inline
in the tests.

Numbers, names, branches, references and clocks are invented.
