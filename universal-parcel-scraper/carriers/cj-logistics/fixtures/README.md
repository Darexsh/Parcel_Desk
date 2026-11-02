# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `selectTrackingDetailList.do`, oldest
scan first, with every field a scan row carries. `delivered.json` goes from the pickup at a
direct route whose label names its driver to the delivery: one unloading scan is repeated, the
departure and delivery lines name the courier and a mobile number, the delivery names its
receiver, and the courier records a second departure after the delivery. `in-transit.json` is
between terminals after a postponed release. `no-scans.json` is the scan list for a number
without scans. `waybill-unknown.json` is the reply of `selectTrackingWaybil.do` for a number
CJ Logistics does not know, and `waybill-registered.json` its reply for a waybill registered
before its first scan, with masked sender and recipient.

Numbers, names, phone numbers, branches and clocks are invented.
