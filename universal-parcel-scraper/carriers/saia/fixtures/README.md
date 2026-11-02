# Fixtures

Each file follows the shape of the reply `GET /api/v1/tracking/find-full-details` gives on
Saia's tracking service: the PRO, the shipper and consignee, line items and references, the
delivery and shipment blocks, the history newest first and the terminals. PROs, clocks, names,
places, contacts, references and postcodes are invented.

- `in-transit.json`: the pickup at the shipper's site, the origin, breakbulk and destination
  terminals, and an estimate with its window.
- `delivered.json`: a delivered shipment whose history ends with the delivery run, with a
  signature and delivery clocks.
- `interline.json`: a partner carrier's pickup in Canada, a row without an activity, a repeated
  row and the customer-service notice in place of an estimate.
