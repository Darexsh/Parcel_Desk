# Fixtures

Replies of the tracker's `/tracking/{number}` lookup, in its own shape. `delivered.json` lists
the scans of a parcel from the order to its delivery, oldest first, without attachments.
`in-transit.json` has reached its first hub, repeats one scan and lists two references as
attachments. `redirect.json` is the answer for one of those references, naming the shipment
the page opens next. `not-found.json` is the tracker's answer, with HTTP 404, for a number it
holds neither as a shipment nor as an attachment.

Numbers, references, hubs and clocks are invented.
