# Fixtures

- `delivered.json`: a completed `tracking-request` payload (booking, dispatch and delivery rows) plus recipient remark, address and contact fields that must not survive normalization. Each row's `pincode_info` is a different case for the office point: another office's entry, a verified entry for the scan's office, and an unverified one.
- `export-customs.json`: code-only rows (`ITEM_BOOK` to `TRANSFER_OOE`) through export customs to the office of exchange, with a cached `synced_at`.
- `flight-legs.json`: two office rows, then a take-off at an Indian airport and one at a foreign airport, each labelled `Z` with the airport's wall clock. The newest label is later than `synced_at`.
- `inbound.json`: an export through the office of exchange to the destination's post. Its `(Inb)` rows, one at an office with no name, carry the destination's wall clocks under India's labels. The tests put a Destination card beside it.
- `inbound-codes.json`: the same journey as another reply words it, in bare codes without `(Inb)` marks. The arrival in the destination country is a `MailArrived` row, and two rows have another `event_type`.

All identifiers, offices, pincodes, times and recipient fields are made up.
