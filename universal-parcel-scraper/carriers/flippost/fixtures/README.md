# Fixtures

Replies of Flip Post's `getTrackInfo` API, with the rows oldest first, as the adapter asks for
them. `delivered.json` has the rows of the current API: a planned dispatch date, the arrival in
the destination town, a courier's round the parcel came back from and the delivery, whose
status names the person who took it. `in-transit.json` has the rows as the API manual's
example gives them, with days alone: a leg on the road, the arrival in a hub town and the
planned dispatch of the next leg. `not-found.json` is the answer for a waybill the API holds
nothing for.

Towns, names, days and clocks are invented.
