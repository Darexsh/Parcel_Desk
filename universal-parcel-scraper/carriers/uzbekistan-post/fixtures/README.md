# Fixtures

`delivered.json`, `in-transit.json`, `inbound.json` and `not-found.json` follow the shape of the
tracker's `GET /api/v1/public/test/{number}/` reply for an item of Uzbekistan Post's delivery
system: a header naming the item, its pickup and delivery locations and its package, then its
scans newest first, each with its code, wordings, UTC instant, office, batch and courier, and an
empty aggregator part. `delivered.json` is a domestic item handed over at its delivery office,
`in-transit.json` one sent on after a failed delivery and `inbound.json` mail from abroad with
scans copied from the sending post's data, customs and a refusal code without wording.
`not-found.json` is the reply for a code the tracker has no data on.

`ems.json` follows the reply for an EMS item, which the tracker reads from IPS: one entry with the
sending post's announcement and the scanning record, whose events carry the office's wall clock,
a GMT clock for Uzbekistan Post's own scans, a customs retention reason and a signatory.
`ems-not-found.json` is the 404 reply for an EMS item IPS does not know.

Codes, offices, towns, postcodes, addresses, names, phone numbers, positions, ids and clocks are
invented.
