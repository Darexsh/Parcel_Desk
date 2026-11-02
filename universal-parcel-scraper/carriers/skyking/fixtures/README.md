# Fixtures

The replies follow the tracking page's `ConsignmentMTrack_WebSite_AuthNew` lookup for one
consignment number: its scans oldest first, each naming the consignment, with branch and
location ids, a reference, status flags, manifest kinds and image links beside them.
`delivered.json` goes from a hub to delivery, with a repeated forwarding scan, an out-for-delivery
scan naming the delivery area and the courier, and a delivery saying how it was signed for, with
proof of delivery and booking image links. `in-transit.json` is out for delivery again after a
failed delivery, and its last scan carries a phone number. `not-found.json` is the empty list the
page shows as "No Tracking Information Available".

Numbers, names, phone numbers, references, ids, branches, places, links and clocks are invented.
