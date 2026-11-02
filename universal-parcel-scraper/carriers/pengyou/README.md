# Pengyou

Tracks shipments of Shenzhen Pengyou Supply Chain (深圳市捧友供应链有限公司), a Shenzhen forwarder
with air express lines to Europe and North America whose site is szpy56.com, on its own tenant of
the Hualei (华磊) forwarder platform. The client is shared with [GZYL](../gzyl/README.md), whose
README describes the platform; this carrier keeps its host and status map.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `120.77.149.241:8082`, which the site links, then, when the interface holds no row for the
   number, one POST of the same `documentCode` to the tracking page `trackIndex.htm`, which
   settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address. No account, key, cookie, CAPTCHA or
browser is needed, and no portal link is published. The site itself sends visitors to 17TRACK,
which files these parcels under Pengyou.

## Notes

- An order's timeline can be written whole when the order is created, its rows dated ahead at a
  fixed spacing up to the delivery, and revealed as their clocks pass; universal providers
  relay those rows as scans. A row written more than twelve hours before its own clock is a
  forecast, not a scan, and is held back for good, as is a row dated after the lookup on Beijing
  time. An order whose rows are all held back has no history yet, and the rows written ahead are
  named so that a universal provider's copies of them are set aside. The providers' shared
  reading drops those copies too, by their spacing ([ARCHITECTURE.md](../../ARCHITECTURE.md)).
  The record's own summary status is not read.
- Scan times are wall clocks without an offset on the platform's Beijing clock and are read on
  it, deliveries abroad too: on the destination's clock, some would have been written half a day
  before the delivery they record.
- The record's product name is the service name.
- A row can name its city after its wording, in brackets ("[Shenzhen City]"). The status map
  reads the wording without it, and the row keeps it as written.
- A delivery names its town after the wording, unbracketed, sometimes with a state or province
  and the recipient's postal code, and leaves the row's place empty. The town becomes the place and
  the postal code is dropped.

## Limitations

Rows the status map does not list are staged from their wording by the shared language rules. No
public number has been found, so the reply's fields are known from the platform.

## Numbers

No public source shows a whole Pengyou number. A parcel a universal provider files under Pengyou has
three letters, nine digits and `PY`, so a low rule suggests Pengyou for that layout, and recognition
asks the tracker; the corpus holds a made-up number in that shape. The letters before the digits
may stand for a channel or a shipper, so the rule stays low.

## Links

The tracker's page takes a form post, so no link opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/pengyou`, with `PENGYOU_TRACKING_NUMBER` and optionally
`PENGYOU_UNKNOWN_NUMBER` set outside the repository.
