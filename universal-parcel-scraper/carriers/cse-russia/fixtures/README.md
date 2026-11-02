# Fixtures

The fixtures follow the reply of `GET https://lk.cse.ru/api/new-track/{numbers}`, each with
its order's events in `order_info` and its waybill's in `waybill_info`.

- `delivered.json` is a door delivery. The courier who collected the parcel and the one who
  delivered it are named in the info of their events. There is a failed attempt the day
  before delivery, and the place of the registration event is another office's.
- `in-transit.json` answers a query by order number. The waybill has its own number, and its
  creation event names the order. The parcel comes from China, and its China scans give
  Moscow as their place. The plain number comes back in `notfound`.
- `pickup.json` is a parcel redirected from one pickup point to another, and the pickup point's
  events give a third town as their place. Each point has an address, hours and a phone.
  The newest event and the summary are notices.
- `not-found.json` is the reply for an unknown number in both layouts.

Numbers, names, phones, places, addresses, identifiers and clocks are invented.
