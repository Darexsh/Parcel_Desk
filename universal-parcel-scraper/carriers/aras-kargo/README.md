# Aras Kargo

Turkish Aras Kargo parcels, through the legacy tracker at `kargotakip.araskargo.com.tr` that
merchants link to.

## How it works

1. `direct`: four anonymous `GET`s in one session, with every cookie the tracker sets sent back:
   - `/mainpage.aspx?code=<number>` finds the parcel, keeps it in a new session and redirects
     to `/kargotakip.aspx`. A number it does not know stays on the page with its notice.
   - `/kargotakip.aspx` names the summary frame, bound to the shipment by an opaque id.
   - `/CargoInfoWaybillAndDelivered.aspx?shipmentid=…` gives the current status, the delivery
     time, the planned delivery day, the delivery branch and the days a delivery was not made.
   - `/CargoInfoTransactionAndRedirection.aspx` gives the vehicle movements and any
     redirection, for the shipment the summary frame put in the session.
2. `retry`: once more, from a new session, after a request that failed to reach Aras or hung.

No key, account or CAPTCHA is needed.

## Numbers

Every number the tracker knew has thirteen digits starting with 60 or 65; a fourteen-digit number
from a complaint came back not found. The adapter refuses any other shape without a request.
Thirteen digits are shared by several posts and couriers, so a low rule offers Aras Kargo for
those prefixes and recognition asks it first when the number is looked up from Turkey.

## Notes

- The new site's tracking form needs an image CAPTCHA, so it is not used.
- The session needs the load balancer's cookie as well as ASP.NET's: with ASP.NET's alone the
  tracking page sends the browser back to the lookup.
- Both frames must name the requested number. A frame that comes back empty, or without its
  grid, did not get the shipment from the session and is inconclusive, as is any lookup page
  other than the not-found notice for that number.
- Wording is mapped in [status.ts](status.ts). The current status settles a delivery.
  Otherwise a failed delivery after the last movement is the current stage, though the status
  still has the parcel at the delivery branch.
- The movement list comes sorted as text, so the adapter sorts it by clock. Failed deliveries
  and redirections carry only a day; within a day they follow the movements, and the delivery
  comes last.
- The delivery is not a movement: it is read from the status and the delivery time beside it.
  A delivered parcel whose time is empty keeps its status without a delivery scan.
- Clocks carry no offset and stay local wall times, read in the catalog zone.
- The planned delivery day is the estimate while the parcel moves and the day is not behind its
  latest scan.
- Names, the signatory, the delivery code, the identity check, invoice and payment details,
  every free-text note and the SMS tab are never read.
- Recognition runs the whole lookup.

## Links

`kargotakip.araskargo.com.tr/mainpage.aspx?code={number}` opens one parcel.

## Limitations

The tracker shows no out-for-delivery movement, weight, pickup point or service name, and a
return's wording is not yet mapped.

## Testing

```sh
ARAS_KARGO_TRACKING_NUMBER=... ARAS_KARGO_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/aras-kargo
```
