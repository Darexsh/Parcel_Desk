# Techlink

Techlink is 智禾国际物流(深圳)有限公司 (智禾), a Shenzhen cross-border forwarder whose site is
techlinksz.cn, with special-line small-parcel services to Europe and the United States. Its
parcels reach the destination country's courier, which prints its own number; CJ Packet
ships some of its parcels on Techlink's line. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST http://api.techlinksz.com/api/trackinfo/` with the body
   `{"order_nums":"{number}"}`, as the tracking page sends it, with no cookie, token or key. The
   API answers over HTTP only. A lookup that does not reach it gets one `retry`.

- The JSON reply has one entry per number asked, with the scans newest first in `track_list`.
  The entry and every scan must name the whole number asked.
- An order the tracker does not have has no scans and the entry's `msg` is `无订单信息`, which
  is not found. An order it has before its first scan has none and `success`, which is no
  history.
- Each scan has a code (`Warehousing_Packed`), which stages it, English and Chinese wording,
  the wall clock in `actual_time`, a place given as a country code, both countries and the
  last-mile number.
- Techlink's own records are on Beijing's clock: the order's electronic information, which has
  no place, and the warehouse scans in China. Any other scan keeps `local_time`.
- The last-mile number is returned as `delivery_tracking_number` with the destination country.
  The reply does not name the carrier; the shared hand-off proposes the destination's post or
  the carrier whose numbers have that shape.

## Limitations

- No estimated delivery, weight or service name.
- No scan after the hand-off has been seen in a reply, so the zone of such a scan is unknown.

## Numbers

Its waybills are ZHPHD, the date as six digits, six more digits and ML. A sample on TrackShip's
Techlink page and parcels Techlink's tracker answered share the layout, and no other carrier's
rule takes it, so `techlink-1` has high confidence. CJ Packet's tracker finds such a parcel
too, under its own CJ Packet number, so CJ Packet's adapter does not take it.

## Links

The site's tracking page takes no number in its address, and the site is HTTP only, so neither
a link nor a search page is recorded.

## Testing

`npm run test:carriers:live -- carriers/techlink`, with `TECHLINK_TRACKING_NUMBER` and optionally
`TECHLINK_UNKNOWN_NUMBER` set outside the repository.
