# Slovak Parcel Service

Slovak Parcel Service (SPS) parcels in Slovakia, read from the service SPS's own tracking page
calls. Partner networks' numbers that SPS's tracker also accepts are left to their carriers.

## How it works

1. `direct`: a GET to `https://backend.sps-sro.sk/api/tracking/shipment?shipment_id={number}`,
   the request `www.sps-sro.sk/moja-zasielka` sends from the visitor's browser, returns the
   shipment, its parcels and their scans.
   - When it cannot return the shipment, the service answers HTTP 502 for a number it does not
     know and for a shipment whose history failed alike. The adapter then asks
     `find-shipment?shipment_id={number}&source=tracking`, the search the page's form runs:
     its not-found notice makes the number unknown, and any other answer leaves it open.
   - A shipment that comes without scans has them under its dashed parcel number, which the
     adapter asks `parcel-status?parcel_id={parcel}` for, as the page does.
2. `retry`: a request that failed to reach SPS, or hung, is sent once more inside the budget.

## Access

Anonymous: no key, cookie, `Origin` or browser.

## Notes

- The number is sent compact. The service refuses the dashed form the old tracker printed,
  with the same HTTP 502 as an unknown number.
- SPS's tracker accepts four forms: the fourteen-digit parcel number, the sixteen-digit label
  barcode (the parcel number and two digits more), the parcel number without its `703` prefix,
  and an SK label code. The reply names parcels by their barcode, so it must name the
  requested number or the barcode it is short for; two barcodes must agree in full.
- Each scan's numeric code alone decides the stage; the Slovak wording is kept as the
  description. Cash-on-delivery and delivery-notice steps move nothing and are intentional
  gaps in the `statusMap`. From a return to the sender on, the parcel stays returned.
- Scan clocks are Slovak wall clocks without an offset, so events keep `local_time` and the
  result has no instant.
- The sender's data record is filed by SPS's billing department, so it carries no place.
- In a shipment of several parcels, the requested parcel keeps its own scans when the reply
  names them.
- Whether a reply comes in its full or its limited view does not change what is read. The
  sender, recipient, recipient's name, postcode, references, remarks and the handheld's
  coordinates in the reply are never read.
- Recognition asks the same service. Detection offers SPS only for fourteen digits starting
  `703`, at low confidence.

## Limitations

Scans are worded in Slovak only. There is no expected delivery. A parcel handed to a partner
abroad is not followed into the partner's network. A shipment the service no longer holds is
answered as unknown.

## Leads

- The mySPS app's API on `rest.mysps.sk` takes a key its public web app gives every visitor.
  It refuses the fourteen-digit parcel number and does not find the short form, and it shows
  one more step and a code the tracking service has not shown.
- The former Webtrace tracker on `t-t.sps-sro.sk` words scans in English, with fewer rows.
- The shipment and its parcels carry an `internationalReferenceNumber`, presumably a partner's
  number for a parcel sent abroad; no reply has shown one.
- SPS's tracker validates some UPS, DHL and other partner numbers as its own.

## Links

SPS's tracker opens one shipment at `www.sps-sro.sk/moja-zasielka/?shipment_id={number}`: the
page reads the number from the address and runs the search. Lookups archived from its earlier
pages put the same parameter on `/sledovanie-zasielky/`, which now redirects there with the
query, and on `/en/track-trace/`. The former Webtrace tracker takes the number in separate
country, depot and serial fields, so its addresses hold no whole number.

## Testing

```sh
SLOVAK_PARCEL_SERVICE_TRACKING_NUMBER=... SLOVAK_PARCEL_SERVICE_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/slovak-parcel-service
```
