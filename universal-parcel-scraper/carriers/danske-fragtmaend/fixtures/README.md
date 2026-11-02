# Fixtures

`delivered.json` and `in-transit.json` follow the English reply of `GetByConsignmentNumber` and
`GetByColliCode`, newest scan first. `delivered.json` goes from the sender's data to the
delivery over two terminals, lists three collicodes on two goods lines, puts coordinates on the
delivery scan and ends with a scan of an earlier consignment note under the same number.
`in-transit.json` is out for delivery again after a failed attempt, with the delivery date the
reply sets at that attempt. `not-found.json` is the tracker's 404 answer for a consignment note
number it does not know.

Numbers, references, goods, places, coordinates and clocks are invented, and so is the wording of
the failed attempt.
