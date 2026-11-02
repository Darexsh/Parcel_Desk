# Fixtures

`delivered.json` and `in-transit.json` follow the reply of Shipa Delivery's
`.../services/whl/v2/my-packages/{number}`: the order with its pickup and drop-off coordinates,
countries, support phone number and its story oldest first, each status with its courier or hub
in `details`. `delivered.json` is collected in one town, fails a first attempt with the
courier's reason, is rescheduled and delivered on the second round. `in-transit.json` is an
import that clears customs and reaches its destination hub. The parser does not read
`orderStatus`, and the in-transit fixture's value is made up. `not-found.json` is the answer
for a number Shipa Delivery does not know.

Numbers, names, coordinates, phone numbers, ids, links and clocks are invented.
