# Kun Express

Tracks shipments of Kun Express (鲲辰, 杭州鲲辰跨境供应链管理有限公司), a Hangzhou forwarder whose
site is kun-express.com, on its own tenant of the Hualei (华磊) forwarder platform. Its lines
fly parcels from China to the United States, Canada and Europe; on the US line USPS delivers
and the tracker copies USPS's scans into its own record. The client is shared with
[GZYL](../gzyl/README.md), whose README describes the platform; this carrier keeps its host,
status map and the reading of the rows it copies.

## How it works

1. `direct`: one GET to `selectTrack.htm?documentCode=<number>` on the tracker at
   `1.117.249.36:8082`, then, when the interface holds no row for the number, one POST of the
   same `documentCode` to the tracking page `trackIndex.htm`, which settles not-found
   ([hualei.ts](../gzyl/hualei.ts)).
2. `retry`: the same read once more after a request fails to reach the tracker or hangs.

The tracker answers plain HTTP only, on a bare address that can move. No account, key, cookie,
CAPTCHA or browser is needed.

## Notes

- The forwarder writes its own rows in English: the order data, its warehouse's receipt
  (`ARRIVAL`) and departure (`SHIPMENT`, a row without text whose place `KUN Warehouse` stands
  as the wording), Hangzhou sorting, export clearance and the flight. [status.ts](status.ts)
  maps them. The rows copied from USPS keep USPS's wording and are staged by the shared
  wording rules.
- Scan times are wall clocks without an offset. The forwarder writes its own rows to the
  second, on the platform's Beijing clock. The rows it copies from USPS come to the minute on
  the facility's clock, as USPS's explanation of each row states, so a row to the minute keeps
  its wall clock in `local_time`, and one at midnight, USPS's row without a time, only its day.
  A row dated after the lookup on Beijing time is held back.
- The tracker can copy one USPS scan three times: alone, after its place, and with USPS's
  explanation after an arrow, which can add the scan's category before the wording. The place
  and the explanation are cut, and at one clock and place a wording that ends with another after
  a comma counts once, as the shorter. The explanation repeats the recipient's town and ZIP
  code; ZIP codes are cut from places too.
- The record's product name is the service name. Records name no channel or transfer number,
  so no delivery carrier or USPS number is handed over.
- The tracker also finds a parcel by the shipper's reference, and then names the KUN number.

## Limitations

The USPS number is never shown, so USPS cannot be asked directly; the history goes only as far
as the forwarder has copied it.

## Numbers

Kun Express's tracking numbers are KUN and ten digits. The prefix is the brand's and no other
carrier issues the layout, so the rule has high confidence. Kunyoung Express, a Korean carrier
with numeric invoices, is unrelated.

## Links

The forwarder's tracking page is `1.117.249.36:8082/trackIndex.htm`. Since it is plain HTTP on a
bare address, no portal link is published, and the canary checks 17TRACK instead.

## Testing

`npm run test:carriers:live -- carriers/kun-express`, with `KUN_EXPRESS_TRACKING_NUMBER` and
optionally `KUN_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
