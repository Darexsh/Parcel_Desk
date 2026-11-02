# Fixtures

The replies follow the English tracking page's lookup for one number: `code` 0 and the waybill,
with the country it goes to, the destination courier's number and the scans newest first by wall
clock, each a date, a place and a wording.

- `delivered.json` is a parcel collected at a warehouse named for a city in China, flown to Canada
  with a connecting flight and delivered by Straightship, whose wording repeats the place with
  its province. It has a delivery forecast, two partners' records of the parcel's data and a row
  listed twice.
- `in-transit.json` is a parcel flown from Hong Kong to Amsterdam for Germany and announced by the
  airport's ground handling agent, with partners' records of the parcel's data.
- `not-found.json` is the lookup's answer for a number the tracker does not know.

Numbers, clocks, offsets and the towns abroad are invented.
