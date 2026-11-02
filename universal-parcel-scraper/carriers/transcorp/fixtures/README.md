# Fixtures

The fixtures follow the reply of `GET /shipments/track?references={number}` with `RSC: 1`: the
page's React Server Components, trimmed of most layout rows. Each keeps the stream of
length-prefixed chunks the page repeats itself in, holding an answer for another number, and
ends with the component keyed with the reference asked.

- `delivered.rsc` is a shipment moved from the legacy portal, operated in Kuwait. Its stamps
  are Kuwait's wall clocks read as Dubai time. It goes from the customs facility through a
  pickup from customs, a delivery run that ends back at the hub and a contact update, to the
  delivery.
- `in-transit.rsc` is a current shipment with UTC instants, a consignee and a shipper, between
  hubs after its first pickup, with an internal notification as its newest event.
- `not-found.rsc` is the backend's message for a number Elite does not know.

Numbers, names, places, references, coordinates and clocks are invented.
