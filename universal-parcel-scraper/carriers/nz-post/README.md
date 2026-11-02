# NZ Post

Tracks domestic parcel barcodes, courier labels and postal references through
the anonymous consumer service used by NZ Post's tracking page.

## How it works

One GET returns the parcel reference and actual tracking events. No account,
API license, cookie or browser is required. Only one exact returned reference
is accepted; consignments that expand into several parcels are inconclusive.

## Notes

A courier label is sixteen digits followed by a depot code, three digits and a
two-letter suffix. The tracker answers only the whole label, so detection claims
that shape and the adapter sends it unchanged.

The short status and depot name provide the timeline. International mail scans
carry their own EDIFACT codes; the border agency's hold is customs and its
release resumes transit. The depot placeholder for a scan with no place is
dropped. Longer descriptions,
signatures and delivery assets contain recipient data and are excluded.
Pickup requests remain pre-advice until a collection scan occurs. Empty history
is inconclusive; only the service's specific absence response is negative.

## Limitations

Explicit offsets establish event instants, except abroad. NZ Post reads the
wall clock of a scan abroad as New Zealand's: a Guangzhou customs scan at 12:47
local came as `00:47Z`, 12:47 in Auckland, where UPU dates it 12:47 at the
Guangzhou office of exchange (checked 2026-10-10). So on an item NZ Post sends
abroad (an S10 number ending `NZ`), each scan after the international departure
gets its wall clock back on Auckland's. It is read on the clock of the country
its depot names ("Hong Kong"). When the depot names a town ("GUANGZHOU") or
nothing, it borrows a country, a guess: that of the nearest earlier scan after
the departure whose depot names one, an airline's included ("China"), else of
the nearest later one. NZ Post names no destination. The borrowed country can
be a transit hub's, but Hong Kong, Singapore and China all keep `+08:00`, and
the guess beats Auckland's clock, 4 to 17 hours off abroad. When the country
has several clocks, or none is named, the scan keeps NZ Post's Auckland
reading, the last guess: hours off, but the reply keeps its instant, and the
history keeps NZ Post's order. Airline scans ("In transit with airline") are
taken as sent: their clocks were not checked.

On an item from abroad (an S10 number another post issued), NZ Post relays the
origin post's scans on the same Auckland reading: China Post's acceptance at
14:51 in Guiyang came as `01:51Z`. Each scan before the item's international
departure gets its wall clock back, unless the item is already in New Zealand
(a depot there, its arrival or its border clearance). It is read on the clock
of the country its depot names, else of the nearest scan before the departure
that names one, else of the post that issued the number. A country with several
clocks keeps the Auckland reading. The app identity policy in
[identity.ts](identity.ts) (`relabelledFrom: 'Pacific/Auckland'`) lets a scan
on its own clock take over the row stored under Auckland's reading, by wall
clock, provider code and location.
Missing, malformed or offsetless clocks preserve the source order without
borrowing an older scan's timestamp.
See [ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md) for unresolved history handling.
Delivery estimates and account-only delivery controls are not retrieved.

## Testing

Run `npm run test:carriers:live -- carriers/nz-post`.
Set `NZ_POST_TRACKING_NUMBER` outside the repository for a real parcel.
