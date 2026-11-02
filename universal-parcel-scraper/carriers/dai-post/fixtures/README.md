# Fixtures

Synthetic replies: numbers, places, clocks, build ids and chunk names are invented. The
`.rsc` files keep the rows of the live `RSC: 1` reply of `daipost.com/track`: module rows,
the route row with the layout's generic 404 template and the header's empty search field, text
rows that end without a line feed so the next row follows on the same line, and the page row.
In `delivered.rsc` and `in-transit.rsc` the page row holds the tracking view's
`trackingresponse`; in `not-found.rsc` it holds the absence heading and the search field
filled with the number. `delivered.rsc` is a New Zealand parcel with a scan repeated and an
out-for-delivery scan listed above the delivery at the same clock; `in-transit.rsc` an
Australian one with a delivery window.
