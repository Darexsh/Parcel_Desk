# Meiteshun Logistics

Tracks shipments of Meiteshun Logistics (深圳市美特顺物流有限公司, MTSCN on 17TRACK), a Shenzhen
forwarder, on its own tenant of the Hualei (华磊) forwarder platform. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host and
status map, and reads the places inside its rows itself.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `182.254.194.208:8082`, the address the company site's order search links to, then, when the
   interface holds no row for the number, one POST of the same `documentCode` to the tracking
   page `trackIndex.htm`, which settles not-found ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address, and its login page carries 美特顺物流's
name. No account, key, cookie, CAPTCHA or browser is needed, and no portal link is published.
The company site at `mtswl.com.cn` sits behind a JavaScript redirect and a cookie check, and the
adapter never visits it. The older site at `mtswl.cn` linked to another tracker, which no longer
answers.

## Notes

- Every order follows one script from the collection in Shenzhen to the delivery, whatever the
  destination, and all of its rows are written when the order is created, dated ahead. A buyer
  reported a parcel the script showed as delivered that never came. A row written more than
  twelve hours before its own clock is a forecast, not a scan, and is held back, as is a row
  dated after the lookup on Beijing time. An order whose rows are all held back has no history
  yet, and the rows written ahead are named so that a universal provider's copies of them are
  set aside. The record's own summary status is not read.
- Scan times are wall clocks without an offset, on the tracker's Beijing clock at the destination
  too, as [GZYL's](../gzyl/README.md) are, and are read on it.
- A row's place is inside its text, before a comma (`ShenZhen`, `Hong Kong`, the destination's
  country code). Destination rows add the recipient's town or region after the wording, then a
  comma and the postcode. [parser.ts](parser.ts) splits the place from the script's wording and
  keeps the town; the postcode is dropped. Some orders' rows carry no place at all.
- The map reads the script's wording alone. Its customs row is spelled `Customs clearanceisin
  progress`, and the row before the delivery, `package is on the way`, stays in transit.
- The record's product name, `MTS全球小包`, is the service name.
- Orders without rows answer with the record alone: the order exists, with no history.

## Limitations

The records never name the carrier that delivers abroad, so there is no hand-off. A reference
stored without its dashes is not found.

## Numbers

Meiteshun's waybills are AMTS, nine digits and FS, made by a Hualei number rule; MTS is
美特顺's initials. Buyers post them on a China Post help forum, whose volunteer files them under
a private shipping agent called MTS, and Meiteshun's tracker answers every one of them, so
`mtscn-1` claims the shape. The tracker also accepts the shipper's reference, which no rule
claims.

## Testing

`npm run test:carriers:live -- carriers/mtscn`, with `MTSCN_TRACKING_NUMBER` and optionally
`MTSCN_UNKNOWN_NUMBER` set outside the repository.
