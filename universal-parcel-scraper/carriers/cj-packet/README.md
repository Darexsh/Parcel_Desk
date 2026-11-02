# CJ Packet

CJ Packet is the shipping line of CJ Dropshipping. Parcels leave CJ's warehouses in China with a
forwarder such as Cainiao or Yanwen and are handed to a courier in the destination country,
which often prints its own number. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://www.cjpacket.com/cj-logistics-api/refactoring/cjpacket/track`
   with the body `["{number}"]`, as the tracking page's script sends the numbers in its address.
   It needs no cookie, token, key or browser. The JSON reply has one entry per shipment found,
   with its service, countries, summary status, the forwarder's and the courier's numbers, the
   courier's name and the scans, newest first.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- The tracker reads a number in lower case as unknown, so the number is sent in capitals.
- An unknown number is HTTP 200 with an empty list, which the page reports as "No tracking info
  found.". A 404 or a redirect is a moved route.
- `success: false` is inconclusive; the service gives it for a request it cannot read.
- The tracker also finds a shipment by its forwarder's or its courier's number, so a shipment
  counts only when its own `cjTrackNumber` is the number asked.
- Cloudflare sits in front of the site. Its browser check in place of the reply is a challenge.
- Recognition makes the same request.

## Notes

- Each scan's `eventTime` is the scanning site's wall clock. The forwarder's and the courier's
  scans usually also carry `eventTimestamp`, the same moment in epoch milliseconds, which the
  page shows in the viewer's zone. Their difference is the site's offset, so those scans are
  returned at it. CJ's own label line and some forwarders' scans have no timestamp and keep
  their wall clocks; the label line's clock reads eight hours behind China's.
- The page lists scans by wall clock, so a scan at a European offset can sit below a Chinese one
  it followed. The reply's order stands.
- Scans carry wording only, CJ's own and the forwarder's and courier's as they word them, in
  English or the destination's language. A small map stages the lines the shared wording rules
  miss. The shipment's `status`, one of the tracker's eight tabs, decides the stage; while it is
  one of the tabs before the last mile, the newest scan says which of those legs the parcel is
  on, such as customs at the destination. A delivery's time is its delivered scan's when that
  scan has an offset.
- The courier's lines can open with their place in brackets, which stands in for a missing
  location. A courier's support contact appended to a line, phone numbers, e-mail addresses
  and the person who signed for a delivery are taken out of the wording.
- The courier's number comes from the reply's last-mile field, which the page labels "Last Mile
  Delivery Tracking Number". The courier is handed over when the reply names one the catalog
  knows and its rules fit that number. A USPS routing barcode gives its package identifier.
- The merchant, the order's numbers, the forwarder's number, the origin country and the
  courier's phone are not kept.

## Limitations

- No delivery estimate, weight, sender or recipient. The page's day count is the time in
  transit, not an estimate.
- Older parcels drop out of the tracker, which then answers as for an unknown number.

## Numbers

CJ Packet numbers start `CJP`, then two or three letters, ten digits and `YQ`. Customers quote
them in reviews of the service, and archived lookups on CJ Packet's tracker show both forms.
`cj-packet-1` claims that layout with high confidence: no other carrier uses the `CJP` prefix
with the `YQ` suffix. The tracker also answers the forwarder's number, such as Yanwen's, and the
courier's; those stay with their carriers. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking page at `cjpacket.com` puts the numbers it shows in `trackingNumber`, separated by
commas, and reads them back from there, so `www.cjpacket.com/?trackingNumber={number}` opens
one parcel.

## Testing

`npm run test:carriers:live -- carriers/cj-packet`, with `CJ_PACKET_TRACKING_NUMBER` and
optionally `CJ_PACKET_UNKNOWN_NUMBER` set outside the repository.
