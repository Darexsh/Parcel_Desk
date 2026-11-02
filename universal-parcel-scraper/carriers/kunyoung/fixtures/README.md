# Fixtures

Each file follows the JSON reply of
`mj.kunyoung.com/webinvoicetracehistory/selectListInvoiceTraceHistory.do`, the lookup the
tracking page makes, with its fields in the reply's order and the scans newest first.

`delivered.json` goes from the parcel taken in to the terminal arrival and the delivery, with
the driver's name and phone number, a vehicle plate, a delivery photo address and staff ids, as
replies carry them. `in-transit.json` is the same parcel's shape up to the terminal arrival; no
in-transit reply was seen, so its `lastTraceType`, which the adapter does not read, is a guess.
`not-found.json` is the reply for a number the tracker has not registered.

Numbers, names, sites, plates, ids, addresses, phone numbers and clocks are invented.
