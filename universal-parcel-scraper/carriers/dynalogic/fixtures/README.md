# Fixtures

`delivered.json`, `on-the-way.json` and `registered.json` follow the shape of the tracker's
number-only order reply: the scenario, its four progress steps, the caption and text lines, the
driver's arrival window and coordinates while an order is on its way, and Dynalogic's own
contact details. The caption follows the `Locale` header: `delivered.json` is an English reply,
the others Dutch ones. `registered.json` carries a number with a dash, as some merchants' numbers
have. Numbers, ids, clocks, coordinates and contact details are invented. `not-found.json` is
the reply for a number the service holds no order under.
