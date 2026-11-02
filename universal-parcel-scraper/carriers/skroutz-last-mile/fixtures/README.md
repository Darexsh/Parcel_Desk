# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `api.sendx.gr/user/hp/{voucher}`:
the overall state and its wording, the scans, oldest first, each with its English and Greek
wording, a tracking state and a UTC instant, then the delivery estimates and the parts of the
page the adapter does not read. `delivered.json` goes from the pickup at the shop through two
hub scans, two planned delivery days and the round to the delivery, which the reply lists
twice. Its delivery notes name the recipient and where the courier stood, and one row has no
wording, as the page hides. `in-transit.json` has reached a partner courier's hub and then a
Skroutz Last Mile hub, with a delivery day planned. An unknown voucher is a plain-text
`Package not found` with HTTP 400, written in the tests.

Vouchers, ids, names, hubs, order codes, coordinates, tokens, overall states other than
`delivered` and clocks are invented.
