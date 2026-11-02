# Fixtures

`delivered.html` and `in-transit.html` are the tracker's English page for one shipment: the
heading with the number and the shop's reference, the shop, the progress rail and the history,
newest first, after the commented-out sample list the page keeps. `delivered.html` goes from the
creation through the messages about the delivery location, an arrival at a city's facility, a
failed attempt whose reason names the recipient's district, and a return to the facility, to the
delivery. `in-transit.html` has arrived at a facility. The tracker answers an unknown number with
a redirect, which the tests build.

Numbers, references, shops, places and clocks are invented. Icons, styles, scripts and the
notification form are removed, and the rail's state in `in-transit.html` is made up.
