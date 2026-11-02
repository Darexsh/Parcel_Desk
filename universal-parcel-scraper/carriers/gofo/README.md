# GOFO Express

Tracks individual US parcels through the official anonymous tracking service.
Other regional services have separate scope: links to gofo.com's `/us` pages
and gofoexpress.com name this carrier. The French, Italian, Dutch and Spanish
portals name [GOFO France](../gofo-fr/README.md), [GOFO Italy](../gofo-it/README.md),
[GOFO Netherlands](../gofo-nl/README.md) and [GOFO Spain](../gofo-es/README.md).
[GOFO Canada](../gofo-ca/README.md) runs this service at its own path and shares
the adapter's tracker and parser.
The shared home page leaves the national service ambiguous.

## How it works

One bounded JSON POST asks for Pacific clocks, one of the public page's time
options. GOFO US waybills are `GFUS` and 14 digits, or the older `GF` and 13 series and
the `CR` and 12 series of CIRRO E-Commerce, formerly Parcll, which GOFO bought; its tracker still serves both. Detection only suggests GOFO, and
recognition asks it: for an AliExpress parcel GOFO shows only the label while
Cainiao's tracker follows the GFUS waybill from China, so recognition asks
[AliExpress](../aliexpress/README.md) too.

The waybill must be the requested number; the tracking number repeats it
or is the shipper's own reference, never another GOFO number. The exception is a
GFUS waybill whose tracking number is a CR number: asked for either, GOFO returns
that one parcel, so both are tracked. The latest summary must agree with the
first scan.

When the user picks GOFO, or opens a GOFO link carrying one, a YunExpress `YT`
number that GOFO delivers under the same number is sent too, and GOFO must give it
as both waybill and tracking number. Detection reads these numbers as YunExpress's. GOFO files a `YT` number
it does not deliver under another region, so that answer stays inconclusive.

The public page renders the whole list without paging and ignores the event
counter, which can count scans the list omits. A larger counter is accepted only
while the list still starts at label creation, so a list cut at either end stays
inconclusive, as do contradictory counts, regional reroutes and empty responses.
Only the explicit US error list proves absence.

## Notes

The page's default "Local Time" setting prints each scan's local clock with
Pacific's offset, which would put Mountain, Central and Eastern scans one to
three hours late. Each requested clock must carry Pacific's offset at that time,
and the instant is expressed in the scan's own zone when GOFO names a valid one.
Clocks without offsets remain local; incomplete clocks retain provider text
without advancing freshness. Current status comes from the latest scan, and
delivery requires confirming wording.
As on the public page, scan wording drops the support contact line GOFO appends
to some scans.
`service_name` is the `serviceName` GOFO gives, as written.
Detailed delivery prose and proof images are excluded. The weight has no
verified unit, and estimates have no verified active-parcel provenance, so both
are omitted. Proof lookup requires a postcode and is not queried.

`clock.ts` lists the zone GOFO gave each station it named (`processLocation`) on the
corpus's and benchmark's parcels, for relays that keep only the station's name and its
wall clock (Ship24). A label is created on Pacific time wherever the parcel is, and a
delivery round, named after the recipient's town, kept its delivery station's zone.

## Live test

Set `GOFO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/gofo/adapter.live.test.ts`.
Optionally set `GOFO_UNKNOWN_NUMBER` to check explicit absence.
