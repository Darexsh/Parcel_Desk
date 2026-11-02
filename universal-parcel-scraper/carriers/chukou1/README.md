# Chukou1

Chukou1 (出口易) is a Guangzhou cross-border logistics company with overseas warehouses and
direct lines from China. It flies parcels to the destination, clears them and hands them to a
postal or last-mile carrier there. Tracked through the lookup the tracking page of its
EC-FirstClass platform makes.

## How it works

1. `direct`: one `POST https://ec-gateway.chukou1.com/api/v1/trackings?lang=en-US` with the
   body `{"securityKey":…,"securityValue":…}`, as the tracking page on `ec.chukou1.com` signs
   it. It needs no cookie, account, CAPTCHA or browser.
2. `retry`: a lookup that fails to reach the service, or hangs, runs once more within the
   budget. The first try gets half of the budget.

- The page's script signs every lookup with a text it ships to every visitor. `securityKey`
  is the MD5 of the UTC clock (`yyyyMMddHHmmss` and hundredths) followed by that text, then
  the clock's last four digits. `securityValue` is the number, encrypted with AES-256-CBC under
  that hash with the text as IV, in hex. The adapter signs the same way.
- The gateway refuses a clock far from its own with HTTP 400, error `200F1004` (`Query
  illegal!`) and its own `UtcDateTime`. When that clock is more than ten seconds from the one
  signed, the adapter signs once more with it. A refusal at the gateway's own clock means the
  page signs differently now.
- The JSON reply lists the shipments asked. A number the tracker does not know comes back with
  `orderStatus` `NotFound`, which is not found. A 404 or a redirect is a moved route.
- The tracker matches numbers in any case. The shipment must carry the number asked.
- Recognition makes the same request.

## Notes

- Scan clocks are `MMM dd yyyy hh:mm AM` with no zone, the scanning place's own. One history
  runs from China's clock to the destination's, so the clocks stay `local_time`. The scans of
  all feeds are put in one list, newest first by those clocks.
- Chukou1's own scans write the place, then the wording, as `SHENZHEN, China, Item received by
  Logistics Centre`. The place becomes the location and the map stages the wording. The open
  API's scan codes never reach the page, which shows only their wordings.
- Each carrier the parcel was handed to has its own feed of scans, kept whole because their
  wordings hold commas. The shared wording rules stage the English ones. China Post's Chinese
  wording has no rule, so the parcel keeps an earlier scan's stage. China Post can come in two
  feeds that repeat the same scans with their places written differently; a scan another feed
  gave at the same minute with the same wording is left out.
- The shipment's `Delivered` stands over an earlier scan, unless a later one says the parcel
  went back. `InProcess` and `InTransit` stage a parcel no scan stages.
- Scans lose the destination postcode, other bare postcodes and site codes, phone numbers, a
  delivery's receiver and repeated parts. The proof of delivery, a PDF of photos embedded in
  the reply, and the origin supplier are not kept.
- The reply names the destination carrier by its service or its feed, and its number. When the
  catalog tracks that carrier and the number is one of its own, they become `delivery_carrier`
  and `delivery_tracking_number`, without the ZIP code a USPS routing barcode opens with.
  Otherwise there is no hand-off.
- The older tracker at `www.chukou1.com/LogistictsTrack.aspx` asks for an image CAPTCHA on
  every lookup.

## Limitations

- No ETA, weight, service or delivery instant with a zone.
- Scans hours apart in different zones can swap places in the merged list.
- The adapter takes only Chukou1's processing numbers.

## Numbers

A Chukou1 processing number (处理号) is three letters naming the service, the date as six
digits, a three- or four-character customer code and a six- or seven-digit serial. Sellers
give it to marketplaces as the tracking number with Chukou1 as the carrier. Chukou1's API
documentation shows this layout in its examples and archived lookups on its tracker show more.
Rule `chukou1-1` claims the layout with low confidence, for customer codes that start with a
letter, because the service and customer codes vary. The adapter also takes codes that start
with a digit and hold a letter, which the tracker knows. Shorter letter-and-digit inputs seen
on the tracker stay quarantined: the tracker also accepts partner numbers, so their owner is
unclear. Destination carriers' numbers stay with their carrier. The samples and their sources
are in [`numbers.json`](numbers.json).

## Links

The tracking page reads `track_number` on `ec.chukou1.com/track` and looks it up on load, so
`ec.chukou1.com/track?track_number={number}` opens one parcel. The older tracker reads `trackNo`
on `LogistictsTrack.aspx` into its search box. Both also take partner numbers, so a link names
Chukou1 only for a number its rule offers.

## Testing

`npm run test:carriers:live -- carriers/chukou1`, with `CHUKOU1_TRACKING_NUMBER` and optionally
`CHUKOU1_UNKNOWN_NUMBER` set outside the repository.
