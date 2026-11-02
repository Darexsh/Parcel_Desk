# Fixtures

The replies follow `api/portal/trackshipment/{waybill}`'s JSON, as the tracking page asks it.

- `delivered.json` is a shipment created in the app, collected and carried to a hub, where the
  customer collected it. The scans are newest first, as the tracker lists them, and one is
  listed twice. A scan's place is an address, and the addresses, the scanning staff and the
  incident text naming the receiver are present so the tests can show they are left out.
- `not-found.json` is the answer for a waybill the tracker does not have, with a shortened
  stack trace.

Waybills, places, clocks, names and addresses are invented.
