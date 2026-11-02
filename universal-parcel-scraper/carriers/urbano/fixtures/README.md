# Fixtures

Replies of the tracking page's lookup, `POST https://api.urbanoenvios.pe/api/v1/trackingGlobal`,
newest movement first as the service lists them. Each shipment carries the fields the real reply
has, among them the recipient's name, address, phone, e-mail and ID document, the contents, the
GPS points of visits and the signatory in the summary.

- `delivered.json` goes from the order's creation in Lima through the line haul to a failed visit
  for a wrong address, a run recorded with its day only, and the delivery. One arrival is listed
  twice, and one movement has no wording, only an internal note.
- `in-transit.json` was asked by its guía barcode and has been dispatched from Lima.
- `not-found.json` is the answer for a number the tracker holds nothing for.

Numbers, names, addresses, IDs, phones, couriers, vehicles, contents and clocks are invented.
