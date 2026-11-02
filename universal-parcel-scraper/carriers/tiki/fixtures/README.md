# Fixtures

Each file follows the reply of the `connote/information` lookup TIKI's Android app makes: the
envelope's `status`, `msg` and `response`, the list of the consignment's pieces. Each piece has the
resi, its piece number, the sender and recipient with their provinces, the product, the weight,
the fees, the estimate and its scans newest first. A scan has an offset-less clock, a code, the
office with its town in brackets, the town and the wording.

- `delivered.json`: one piece, from data entry through a failed attempt to a delivery whose
  wording names the receiver and a phone number.
- `in-transit.json`: one piece on its way, with scans that name no town of their own.
- `pieces.json`: a consignment of two pieces sharing their data entry; one is delivered, the
  other has reached the destination office.
- `not-found.json`: the answer for a resi the service does not know.
- `token-refused.json`: the answer, with HTTP 403, to a token the service does not accept.

Numbers, names, phone numbers, offices, manifests, fees and clocks are invented.
