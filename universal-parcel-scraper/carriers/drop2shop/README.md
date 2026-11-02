# Drop2Shop

Drop2Shop is COLL-8 Logistics' service through Irish convenience stores, where shoppers
collect online orders and drop off returns. COLL-8 clears inbound parcels through Irish
customs and hands them to a partner for the last mile; in the captured histories that was DPD
Ireland. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.drop2shop.ie/api-ship/tracking/{number}/scan`, as the
   tracking page sends it. It needs no cookie, token, key or browser. The JSON reply lists the
   scans of every package of the shipment, in no particular order.
2. `retry`: one more try when the request fails to reach Drop2Shop or hangs. The first try gets
   half of the budget.

- An unknown number is HTTP 200 with `{"data":[]}`, which the page reports as not found. A 404
  or a redirect is a moved route.
- Each scan names its package, the shipment's number and three digits. A scan of another
  shipment makes the answer inconclusive.
- Recognition makes the same request. The tracker still answers parcels from several years
  back, so a known number is positively told from an unknown one.

## Notes

- Clocks have no offset, and two clocks share one history. COLL-8's own records, the parcel's
  creation (`DAT`) and its customs entries (`CUSM`), are UTC: a creation runs an hour behind
  the sender-data scan it comes with during Irish summer time and agrees with it in winter,
  and in archived replies both kinds kept the milliseconds the partner's scans lack. The `D2M`
  codes relay the partner's scans with their wording, and DPD Ireland's clocks are Irish wall
  time. Other codes are read in Irish time too.
- The code stages a scan; a code the map does not know falls to the wording rules. The
  tracker now words `D2MD001` as a delivery, also on parcels it once showed as collected from
  the pickup point.
- Beside the newest scan the page links the partner's tracker with the partner's reference.
  COLL-8's carrier list sends a DPD parcel to `dpd.ie` with `odaTrackingNumber`, so a DPD
  scan gives `delivery_carrier: 'dpd-ie'` and that number, when DPD Ireland's own number rule
  takes it whole. The other partners on the list give no hand-off.

## Limitations

- No scan location, pickup point, weight or delivery estimate: the reply has none, nor any
  recipient details.

## Numbers

Drop2Shop numbers are GLB and thirteen digits; archived lookups on its tracking API show them
in upper and lower case. No other carrier's numbers or rules use that shape, but GLB does not
name the carrier, so the rule only suggests Drop2Shop and recognition confirms it. The
partner's reference belongs to that carrier, such as dpd-ie.

## Links

`drop2shop.ie/tracking` with `trackingnumber` opens one parcel, on the main host and on the
`coll8` host. Return confirmations link to the same page with `trackingNumber`.

## Testing

`npm run test:carriers:live -- carriers/drop2shop`, with `DROP2SHOP_TRACKING_NUMBER` (a parcel
handed to DPD) and optionally `DROP2SHOP_UNKNOWN_NUMBER` set outside the repository.
