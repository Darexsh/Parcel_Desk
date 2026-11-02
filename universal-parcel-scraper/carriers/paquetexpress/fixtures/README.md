# Fixtures

Each file follows the shape of the row list `GET /ptxws/rest/api/v1/guia/historico/{number}/{token}`
returns inside its `Resultado(...)` call, oldest row first: the code, wording, branch, place, clocks,
estimated day, delivery type, guía, tracking code and reference of each scan. Numbers, guías,
branches, places, clocks, references and the people named in the wording are invented.

- `delivered.json`: a parcel from its web-services label to the door, scanned at branches an hour
  behind central time, with a row the tracker hides, two rows out of order and a printed date a
  day off.
- `two-parcels.json`: a guía of two parcels that share their first rows; one is delivered and the
  other is still on its way through branches ahead of and two hours behind central time.
- `pickup.json`: a parcel to collect at its branch, from before Mexico ended daylight saving time,
  waiting there.
- `pickup-request.json`: a pickup request and its cancellation, whose branch clock does not fit a
  whole-hour difference.
