# Fixtures

The files follow the reply of the tracking page's `queryTrack` lookup in English.
`swiftx-at-warehouse.json` is a US parcel at DHLink's warehouse, with its two nodes and a SwiftX
last-leg number. `postal-delivered.json` is a China Post parcel delivered in the United Kingdom:
most scans come twice, from a feed in English and one in Chinese that appends the destination's
code to its places. `usps-relayed.json` is a parcel on DHLink's own line whose DHLink number is
its tracking number, with USPS's scans relayed by two feeds and one scan in two formats.
`not-found.json` is the answer for an unknown number.

Numbers, ids, places and clocks are invented.
