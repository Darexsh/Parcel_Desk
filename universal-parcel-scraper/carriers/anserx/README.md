# AnserX

AnserX (斑头雁国际物流) is a Shenzhen cross-border logistics company with dedicated lines from
China. It flies parcels to the destination, clears them and hands them to a carrier there,
whose number it records as the delivery number (派送单号). Tracked through the lookup its
tracking page makes.

## How it works

1. `direct`: one `GET https://oms.anserx.com/client/cs/anserxWebsite/tracking/getTrackInfo`
   with `nos={number}` and `internalFlag=0`, the request the tracking page on `oms.anserx.com`
   makes. It needs no cookie, token, CAPTCHA or browser.
2. `retry`: a lookup that fails to reach the service, or hangs, runs once more within the
   budget. The first try gets half of the budget.

- The JSON reply lists the shipments found, each with its scans newest first. A number the
  tracker does not know leaves the list empty and counts as abnormal, which is not found.
- An envelope with another `code` than 0 is the service's own failure, not an answer about the
  parcel. A 404 is a moved route.
- The tracker matches numbers in any case. The shipment and each of its scans must carry the
  number asked.
- Recognition makes the same request.

## Notes

- The tracking page says every scan time is the time where the scan happened. One history runs
  from China's clock to the destination's, and the reply gives no zone, so the clocks stay
  `local_time`.
- A scan's description is its English wording, or its Chinese one when the English is empty.
  The `trackingCode` (`BTY_LASTMILE_DELIVERED`) stages it. The clearance code's English says
  export customs while its Chinese says import clearance at destination, where it is placed;
  either way the parcel is back in transit.
- Delivery scans name the town, a full-width comma and a postcode. The adapter keeps the
  town and drops the postcode. Scans in a country's network name only its code.
- The delivery number becomes `delivery_tracking_number`, without the ZIP code a USPS routing
  barcode opens with. The reply has fields for AnserX's channel and supplier codes but no
  carrier name, so there is no `delivery_carrier`, and the hand-off goes by the number's own
  rules.
- The reply also carries the customer's account code and order reference, which the adapter
  does not keep.

## Limitations

- No ETA, weight, service or delivery instant with a zone.
- The adapter takes only the layout below.

## Numbers

The AnserX number seen is `BTY`, `CN`, ten digits and `YQ`, in an address of AnserX's own
tracker. The tracker calls these BTY numbers its own, so rule `anserx-1` claims the layout
with high confidence. Delivery carriers' numbers stay with their carrier.

## Links

The tracker on `oms.anserx.com` reads the numbers it shows from `nos` on `/tracking`,
separated by commas, and the home page's search opens that address, so
`oms.anserx.com/tracking?nos={number}` opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/anserx`, with `ANSERX_TRACKING_NUMBER` and optionally
`ANSERX_UNKNOWN_NUMBER` set outside the repository.
