# Fixtures

Each JSON file follows the reply of the tracking page's `/api/track/locate` for one number: the
consignment's labelled details, then each item's rows, oldest first, the first naming the item.
`delivered.json` is a one-item consignment with its weight, references, receiver and driver, a
sender's despatch note, a failed pickup with a line break, a row without wording, a line haul, a
failed delivery pointing to a support link, a rescheduled delivery and a delivery with authority
to leave. `in-transit.json` is a two-item consignment on its way, picked up before its shipment
details arrived, whose items repeat their shared scans. `coupon.json` is a prepaid coupon,
collected from a newsagency. `not-found.json` and `unlisted.json` are the two answers for a
number the tracker does not know. `page.html` is the tracking page with its session token.

Numbers, references, people, depots, places, tokens and clocks are invented.
