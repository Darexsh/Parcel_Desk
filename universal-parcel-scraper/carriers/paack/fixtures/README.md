# Paack fixtures

- `delivered-order.json`: `routes/tracking.order` loader payload for a delivered order with
  an earlier incorrect-address attempt and a delivery window. Built around the order number
  from Paack's public API examples; every retailer, recipient, contact, address and
  `variables` field is a `PRIVATE …` placeholder so the test can assert none leaks.
- `label-barcode-order.json`: the same loader for an order looked up by its label barcode,
  with the structure of a live reply. `external_id` is the retailer's own reference, not the
  barcode. The event headers show `expected_delivery_ts` as the delivery day and time slot,
  and the timeline lists the steps still to come without a timestamp. Times and the delivery
  postcode are synthetic; retailer and order references are `PRIVATE …` placeholders.
- `pudo-ready-order.json`: the same loader for an order waiting at a PaackGo Point
  (`droppedInPudo`), built from the tracking page's code and translations rather than a live
  reply: the step labels, `pudo_name`, the one-string `pudo_address` and the fields the page
  prints next to them. The PaackGo Point steps' ids (`PUDO1`…) and their `variables` are
  placeholders. The point's name and address are invented; the pickup code, QR link and every
  recipient field are `PRIVATE …` placeholders so the test can assert none leaks.
- `evri-international.html`: Evri International's tracker answering a Paack number, in the
  structure of a live reply: the Evri barcode in the heading and System Tracking, the Paack
  number in Carrier Tracking and the search box, "Paack 48H" as Carrier, then Evri's scans and
  Paack's. Numbers, clocks and places are invented; sender, destination and comments are
  `PRIVATE …` placeholders.
