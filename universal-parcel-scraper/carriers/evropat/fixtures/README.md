# Fixtures

Each fixture follows the reply of the lookup Evropat's tracking page makes for one waybill,
`POST evropat.bg/wp-json/evropat/v1/track`: `ok` and the waybill's steps, oldest first, each
with the waybill, its state, its additional information and its clock.

- `delivered.json` is a waybill collected by a courier, taken into an office, carried on a line
  to another office and delivered. The courier and delivery steps name people.
- `in-transit.json` is a grouped waybill taken out of its group in the hour the autumn clock
  change repeats, followed by a state the map does not know.
- `not-found.json` is the answer for a waybill the lookup does not have, with HTTP 404.

Waybills, offices, lines, couriers, people, notes and clocks are invented.
