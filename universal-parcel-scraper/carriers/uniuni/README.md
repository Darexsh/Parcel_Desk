# UniUni

Tracks individual parcels recognized by the official anonymous tracking page.
Universal providers name the carrier by its former company name, UNI Express,
which is its alias.

## How it works

One bounded GET uses the site's fixed public web configuration. Active parcels
also use the optional estimate service. Its website configuration is discovered
from the current official page and cached in memory; no key is embedded for that
service. No browser, account or session bootstrap is needed. Both responses must
identify the whole parcel; master shipments with multiple pieces remain inconclusive.

## Notes

Corrected per-scan seconds provide instants. The older numeric clock field
encodes local wall time and is excluded. A scan's local clock is always on the
zone named with it when corrected seconds come too. Without them, a cross-border
shipper's scan can name another country's zone (London for a scan in Quebec), so
its local clock becomes an instant only when its state or province keeps that
clock then, and the reading keeps the list's order against the scans with corrected
seconds and is not after the lookup. Other scans retain local clocks in provider
order without advancing freshness. Impossible local dates retain their original
text. Current status comes from
the latest actual scan. The legacy estimate field is excluded because the
current page uses a separate service with an explicit enabled flag. Detailed delivery prose, addresses,
coordinates, operators and proof images are excluded.

A scan's place is its city and province, UniUni's only field for where it was scanned. They
can name a gateway or a hub's region rather than the warehouse that scanned, so an arrival
scan can sit hundreds of miles from the delivery round that starts minutes later. The other
place fields name the destination or the recipient.

After a handover, a partner courier's scans arrive without UniUni's English
summary, as does a Uni Store drop-off, which also has no status code. Their own
short scan text is kept as the description; they carry no corrected seconds.
Cross-border shippers' scans arrive the same way, but with code 202 on every row
until delivery, so code 202 on such a row is read by its wording: it otherwise
means out for delivery. The app's review asks the same map by code (`statusMap`)
and leaves 202 open, since a stored row does not say whose scan it is. The parcel's country, the United States or Canada, is the
destination.
Detection claims the `UUS`, `UUSC`, `4C…US` and `U9999` formats, and `UR` with
seventeen digits, the tracking ID of UniUni's seller platform, which its tracker
follows; a `URB` batch ID names no parcel. It suggests UniUni for other `U` and
fifteen-digit references, which Canadian parcels carry.
Cross-border shippers' references of two letters, two digits, `CAA0`, a letter
and nine digits only suggest UniUni: Intelcom's tracker accepts them too. Detection
names UniUni when that letter is `U`: every public one is on UniUni's tracker and
unknown to Intelcom's. Those for the United States carry `USA0` instead; no public
sample shows one, but UniUni's tracker follows them. The `JY` shipper also writes
`JY`, two digits, `CA`, two digits, `A` and nine digits; UniUni's tracker follows
those, and they only suggest UniUni.
Recognition looks them up at UniUni, whose tracker lists a reference it does not
know as invalid.

## Delivery estimates

The [official tracking client](https://www.uniuni.com/tracking/) also posts to
`https://sj.uniexpress.ca/version2/orders/edd_information` with a `tnos` array
and its public website key. It needs no account or browser session. The reply
identifies each parcel by `tno`, with `edd_enabled` and `delivery_estimate`;
an enabled record can still have no estimate.

Only enabled estimates are kept. Dates remain dates; complete windows use their
own explicit zone when it settles an unambiguous clock and otherwise retain
local clocks. An invalid window retains its valid day. Estimate clocks never
change scan clocks. Optional configuration or estimate failures leave history
usable. Delivery and return histories suppress estimates, and recognition reads
history alone.

## Live test

Set `UNIUNI_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/uniuni/adapter.live.test.ts`.
Optionally set `UNIUNI_UNKNOWN_NUMBER` to check an absent parcel.
Set `UNIUNI_ESTIMATE_TRACKING_NUMBER` to check an active parcel with an enabled estimate.
