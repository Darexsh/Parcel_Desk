# Fixtures

The `-track` files follow the shape of the summary `POST /api/v1/tracking/{id}/track` gives on
the service behind 99minutos's tracker: the tracking id, the shop's internal key, the delivery
type, the status code and name, the country, the estimate and the origin and destination. The
`-detail` files follow the history `POST /api/v1/tracking/{id}/detail` gives, oldest first, with
each row's remarks and evidence flag. Numbers, keys, clocks, addresses, stations, remarks and
names are invented; the UPS number is UPS's documentation example.

- `delivered-*`: a Mexican parcel from the order to the delivery, with two copies of one row
  whose clocks differ below the second.
- `colombia-*`: a Colombian parcel after a failed attempt, with the rows its tracker hides.
- `international-track.json`: a shipment UPS carries abroad.
