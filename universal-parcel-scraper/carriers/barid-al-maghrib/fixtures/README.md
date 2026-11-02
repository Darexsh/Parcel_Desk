# Fixtures

`delivered.html` and `in-transit.html` are the tracking page's detail for one item,
`getdetailentrytracking?code=`, trimmed to the search form and the result: the code, the item's
weight, kind, cash-on-delivery amount, departure and arrival, the delivery phone, the progress
rail and the history table, a row per day followed by that day's scans. `delivered.html` is mail
from abroad, from its acceptance by the sending post through customs in Morocco to its delivery,
with one scan listed twice. `in-transit.html` is a domestic parcel sent on after its acceptance.

`not-found.json` is the form's lookup, `getTrackingByCode`, for a code it does not know, listed
under `errors`. `known-summary.json` is its reply for a code it knows, with the recipient's name
and address the adapter never reads. `rejected.html` is a firewall's page in place of the site's.

Codes, offices, towns, names, addresses, phone numbers, amounts, ids, days and clocks are
invented. Scripts, styles and the site's frame are removed.
