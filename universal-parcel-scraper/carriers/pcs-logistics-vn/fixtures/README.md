# Fixtures

The JSON files follow the reply of `track-trace-public` asked in English: one result for the
number asked, with its `shipmentInfo` and its `shipmentStatuses` newest first. `delivered.json`
goes from the order in Hanoi to the delivery in Ho Chi Minh City, lists one scan without wording
twice, and carries a masked recipient, a reference, a weight, pieces and a comment with a name
and a phone number on the delivery scan. `in-transit.json` flies from Hanoi to Japan; its newest
scan is labelled with Japan's clock and the one before with Vietnam's, at a place in Japan.
`no-history.json` is a waybill the tracker knows without scans, as old waybills are, and
`not-found.json` the answer for a number it does not know.

Numbers, names, references, places, clocks, the status codes other than `12` and the wording
`Arrived at destination hub` are invented.
