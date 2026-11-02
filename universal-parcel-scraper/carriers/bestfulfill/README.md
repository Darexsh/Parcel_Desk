# BestFulfill Packet

BestFulfill Packet is the shipping line of BestFulfill, a dropshipping and fulfilment agent in
Guangzhou run by Guangzhou Haoqianyi Trading Co., Ltd. It ships online orders from its warehouses in
China to buyers abroad, where local carriers deliver them. Tracked through the open service its
tracking page on bestfulfillpacket.com asks.

## How it works

1. `direct`: one `GET https://www.bestfulfillpacket.com/openapi/v1/external/tracking?number={number}`,
   the request the tracking page makes. It needs no cookie, token, key or browser. The JSON reply
   names the number, the origin and destination countries and the scans, oldest first, its
   partners' included.
2. `retry`: the same read once more when the service cannot be reached.

- A number the service does not hold gets HTTP 404 with `{"error":"tracking not found"}`, which is
  not found. Another 404, such as the site's 404 page, or a redirect is a moved service.
- The reply must name the number asked.
- Recognition makes the same request.

## Notes

- Each scan's `time` is an instant with the offset of the place it happened, which is kept.
- Each scan carries a 17TRACK-style sub-status, such as `InTransit_PickedUp`, kept as its
  provider code. The code decides the stage where it is specific, with 17TRACK's safeguards:
  generic transit yields to the wording, a delivery code needs a delivery's wording, and a customs
  code yields to wording that says customs is done. The rows seen are in
  [`statuses.json`](statuses.json).
- A United States place's trailing ZIP code is dropped from the location.
- The last-mile carrier's number comes from the reply's `localNumber`, or else from the scan
  `Last Mile Tracking Number: …`, and is kept as the delivery number. The reply's summary status is
  not read; the scans decide.

## Limitations

- No estimate, weight, service or recipient.

## Numbers

Its tracking numbers are BEST and fourteen digits. The one public example, on its home page, comes
from one source, so `bestfulfill-1` suggests BestFulfill Packet at low confidence.

## Links

Tracking links carry one or more numbers, one per line, as `number` on the tracking page.

## Testing

`npm run test:carriers:live -- carriers/bestfulfill`, with `BESTFULFILL_TRACKING_NUMBER` and
optionally `BESTFULFILL_UNKNOWN_NUMBER` set outside the repository.
