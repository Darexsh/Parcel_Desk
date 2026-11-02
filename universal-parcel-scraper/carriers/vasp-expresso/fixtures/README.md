# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `/api/TrackAndTrace` for a
service barcode: the service with its client reference, the flags for the page's progress
rails, the events newest first in Portuguese, English and Spanish, the current event and the
proof-of-delivery flag.

- `delivered.json` is a parcel delivered after a failed round, with the recipient's own
  address change and new delivery day through Track My Parcel, a depot scan listed twice and
  rows whose record stamp equals their wall clock, as rows from delivery rounds do.
- `in-transit.json` went out three times, failing on an insufficient address, on loading
  conditions and on an absent recipient, with a warehouse incidence between the rounds. Its
  current event, back at the depot after the last round, is missing from the list.

The tracker's answer to a number it does not know is an empty HTTP 204, so it has no fixture.

Numbers, references, depots and clocks are invented.
