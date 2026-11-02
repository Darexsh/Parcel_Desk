# Fixtures

The fixtures follow the markup of the tracker's pages: the shipment page `/tt/{number}/{postcode}`
and the search form `Search-shipment` with its notice.

`delivered.html` has two shipping units. Each lists its scans with depot and search code. The
delivery is logged under 39 and again under 0 on one clock, and both units repeat the shipment's
scans. The progress rail names the depots' towns and the person who took the parcel. The page
also shows the sender, the recipient's name and address, a reference, a phone number in a unit's
description, the postcode in the copy link and the delivery box.

`in-transit.html` has one unit. Its arrival scan falls in the hour the clocks repeat when they
go back, and its sorting scan is worded as the delivery estimate. Its depot's town has no
country. The delivery box gives an expected day.

`announced.html` is a shipment with a unit but no scans, under the headline "Zending aangemeld".

`search-unknown.html` is the search form returned with the notice for a number the tracker does
not know.

Numbers, postcodes, depots, names, towns, addresses, references, phone numbers, weights and
clocks are invented.
