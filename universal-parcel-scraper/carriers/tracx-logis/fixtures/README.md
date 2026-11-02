# Fixtures

Synthetic replies: numbers, names, references, offices, flights, clocks and build ids are
invented. The `.rsc` files are React Server Components replies of the tracking page's
`getTrackingHistory` server action: row 0 names the row holding the action's `{ dataInfo,
history }` result, after the module and hint rows the page streams with it. `not-found.rsc` keeps
the live reply for a number the tracker does not know: every summary field null and no scans.

`delivered.rsc` is a parcel from Korea to Japan handed to Sagawa, with its delivery number, the
destination's customs scans, a scan whose details list flight times, and newer codes with the
older ones beside them. `in-transit.rsc` is a K-Packet parcel that has reached Japan, with its
Korea Post number. `attempted.rsc` is a parcel within Singapore whose last scan is a failed
delivery with its reason; its summary gives the parcel's own number as the delivery number.

`page.html` stands for the tracking page, whose streamed server components list the chunks the
tracking view loads, with that list split across two pieces of the stream. `view-chunk.js` is the
view's chunk, which builds the page's action references with `createServerReference`.
