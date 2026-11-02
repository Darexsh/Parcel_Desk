# Fixtures

Each fixture holds the two replies of Anousith's GraphQL API for one bill: `items`, the
`ItemsV2` query's bill with its dates, and `scans`, the `ScanItems` query's scans, newest
first. Times are UTC instants with milliseconds, as the live replies give them.

`delivered.json` goes from one branch through a sorting centre and a province centre to the
destination branch, where the recipient collects it. Its bill also carries the recipient's
name and phone number, the sender and a charge, which the adapter never asks for, to show
that none is kept. `in-transit.json` was booked before the origin branch took it in and has
reached the sorting centre. `returned.json` reaches the destination branch, goes back and is
handed back to its sender. `not-found.json` is the answer for a bill Anousith does not know.
`error.json` is an error the API sends with HTTP 200.

Numbers, names, branches, centres, phone numbers, charges and times are invented.
