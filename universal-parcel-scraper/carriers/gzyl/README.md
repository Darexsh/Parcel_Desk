# GZYL

Tracks shipments of GZYL (广州云链货运代理有限公司), a Guangzhou forwarder, on its own tenant of
the Hualei (华磊) forwarder platform. [Tianhui Hengyuan](../thhy/README.md),
[JRT](../jrt/README.md), [Meiteshun Logistics](../mtscn/README.md),
[Mayi Yinfu](../mayiyinfu/README.md), [BYHD](../byhd/README.md) and
[MeiHoo Pegasus](../meihoo-pegasus/README.md) run tenants of the same platform; they share the
client in [hualei.ts](hualei.ts) and keep their own hosts and status maps.
[Xinghe Freight](../xinghe-freight/README.md) tracks on GZYL's own tenant.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `134.175.243.207:8082`, the platform's documented track interface. It answers JSON encoded in
   GBK, with one record per order and its rows. When it says it holds no row (`未查询到轨迹`),
   the adapter posts the same number as the `documentCode` field to `trackIndex.htm`, the
   tracking page the tenant's site opens. The page answers an unknown number with an empty
   waybill that only echoes the number, which is the only not-found. It also shows the
   platform's own row for an order without scans, which some tenants' interfaces leave out.
2. `retry`: the same read once more after a request fails to reach the tracker or hangs. The
   first attempt gets half of the budget.

No account, key, cookie, CAPTCHA or browser is needed. The trackers answer plain HTTP only, on a
bare address; the shared transport allows it. No portal link is published, since a plain-HTTP
link would leave the number in the clear, and the canary, which takes HTTPS only, checks 17TRACK
instead.

## Notes

- The service matches a number exactly as written: the order's tracking number, the shipper's
  reference, the waybill code or the channel's transfer number, dashes included. A record counts
  only when one of those is the whole number asked; otherwise the error names the record's
  fields that hold the number, a child parcel's list included, without their values, or failing
  that the shapes of the record's own numbers, letters and digits counted. Two orders under one reference stay
  inconclusive. [BYHD's](../byhd/README.md) page hides the number it found an order by, so there
  a lone record counts for the one number the page's form echoes back. [JRT's](../jrt/README.md)
  interface stops returning JRT's own number once the delivering carrier's takes the tracking
  number, so there a lone record holding none of a JRT number counts for it.
- GZYL writes a shipment's timeline ahead: every row carries the same creation time, days before
  most of the scan times. A row the track interface says was written more than twelve hours
  before its own clock is a forecast, not a scan, and is held back on every tenant; the margin
  leaves room for a destination's clock, up to six hours ahead of Beijing's. The page shows no
  creation times, so a row dated after the lookup on Beijing time is held back too. An order
  whose rows are all held back has no history yet. Either way the clocks of the rows written
  ahead are named, in `written_ahead` or the error, so that a universal provider's copies of
  them are set aside too: GZYL's order row alone is kept while the script fills a provider's
  history. The record's
  own summary status is not read; the stage comes from the rows kept. After a row a tenant's
  map reads as returned, a move or a delivery is the parcel going, or delivered, back to the
  sender, and is returned too.
- Rows coded `CO_C_CR` come from the platform's custom track product (轨迹定制), which writes
  them to a script: on Tianhui Hengyuan they read like China Post's scans, all on one second of
  the minute, and on Mayi Yinfu they have the parcel abroad before it reaches the airport. They
  are held back on every tenant and named like rows written ahead.
- Rows carry wall clocks without an offset, abroad too, on the trackers' Beijing clock: rows
  at the destination were shown up to seven hours before their clock read as UTC, earlier than
  the destination's own clock allows, and on the destination's clock some delivery rows would be
  written before they happened. Every row is read on Beijing time, as on the other tenants
  except Mayi Yinfu, where a row copied from the delivering carrier without a place can come on
  that carrier's clock, and [Kun Express](../kun-express/README.md), whose rows copied from USPS
  are on the facility's clock. Each scan keeps the platform's clock when its row was written as
  `written_at`, from the track interface: a row written as it happens is written minutes after
  its clock, so stored rows show which clock a destination's rows are on.
- The platform can write a partner's row again. A copy written after a European clock change
  reads the partner's clock an hour off: Meso Global's DHL rows written in summer time came again,
  written after the change, an hour later. Of two rows alike but for clocks an hour apart, the one
  written later is dropped.
- GZYL leaves a row's place empty and writes the town after some wordings, as in "Leaving the
  sorting center" followed by the town. The adapter reads that town as the place, so a wording
  reads the same for every town. A row can also name its city after the wording, in brackets;
  the status map reads the wording without it, and the row keeps it as written.
- A record that names its channel and the channel's transfer number hands the parcel over when
  the channel label is in the platform's table, the delivery carrier's own detection offers the
  number and it serves the destination. The table holds Swiss Post's labels, the destination of
  every record seen; no live record has named a channel yet. The page names no channel or service.
- Recipient, sender, address, postcode, weight, fee, signature, signatory and delivery photo
  fields are never read; postcodes, with a country's letters before them (`CH-`), and signatories
  are cut from scan text, including a delivery row's place, which can carry the recipient's
  postcode. Wording can name it too, so the cut covers the whole row; a date's year stays. A row stored with one takes the place without it
  ([identity.ts](identity.ts)).
- GBK has no room for some spaces, so a space between two words can arrive as `?`; scan text reads
  it as the space it was.
- A partner's row can come with its markup, escaped or not, such as DHL's help link; scan text
  keeps the words without it.

## Limitations

No proof of delivery: GZYL writes its delivery row in an evening batch, in the order's town as its
rows written ahead are, and the record names no delivering carrier or number.

A reference stored without its dashes is not found. A record with the delivery carrier's number
but no channel label hands nothing over, except on a tenant that names the carriers it hands
records to, as [Mayi Yinfu](../mayiyinfu/README.md) does, or the carrier a product names, as
[JRT's](../jrt/README.md) line to Ireland names FedEx.

## Numbers

GZYL's waybills are YL, ten digits and YQ, made by a Hualei number rule. Many forwarders end
their numbers with YQ and Yili International's are YL, nine digits and YQ, so the rule has low
confidence and recognition asks the tracker. No public GZYL number has been found, so the
corpus holds a synthetic one. The tracker accepts both the waybill's tracking number and its
reference number.

## Testing

`npm run test:carriers:live -- carriers/gzyl`, with `GZYL_TRACKING_NUMBER` and optionally
`GZYL_UNKNOWN_NUMBER` set outside the repository.
