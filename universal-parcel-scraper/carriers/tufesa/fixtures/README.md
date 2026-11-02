# Fixtures

`delivered.json`, `in-transit.json` and `not-found.json` follow the reply of `commdatosenvio`: an
array holding one shipment, its scans oldest first and its delivery block.

`delivered.json` is a shipment the recipient collects at the branch (`OCURRE`), from the check-in
at the origin counter through two stops on the route to the destination branch, the delivery,
the line naming the receiver, and a delivery block with the receiver, coordinates and a stand-in
signature. `in-transit.json` stopped at a stop on the route. `not-found.json` is the answer for a
code TufesaPack does not know, with dashes in every field.

Numbers, names, places, coordinates and clocks are invented.
