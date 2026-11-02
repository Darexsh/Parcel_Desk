# Fixtures

`delivered.json` and `in-transit.json` follow the reply of the tracker app's `QuickTrack`, with
the waybill's summary and its scans in the reply's own order.

`delivered.json` goes from a booked collection to a delivery in another depot's town. The
collecting depot's scans come twice or three times, once without the branch; one manifest scan
is repeated exactly, one scan is marked not to be shown, and a manifest scan arrives the day
after the delivery. The delivery scans and the summary name the recipient.

`in-transit.json` is a parcel handed to DPD from abroad, which failed one delivery round. Its
failure scan gives a phone number and an email address, and a delivery day booked after it is
the newest scan. Its summary puts the parcel on delivery.

An unknown waybill is an empty reply, so it has no fixture.

Numbers, names, places, branches, manifests, contacts and clocks are invented.
