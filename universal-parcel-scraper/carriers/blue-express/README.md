# Blue Express

Blue Express is a Chilean parcel carrier. It delivers online orders and business shipments
across Chile, to the door or to its Punto Blue Express pickup points, and handles parcels from
abroad through customs. Tracked through the scan lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://www.blue.cl/api/tracking/microestado` with the JSON body
   `{"os":"{number}"}`, as the tracking page's script sends it. It needs no key, cookie,
   session or browser. The JSON reply lists the scans by day, newest first, each with its code,
   title and place.
2. `retry`: the same request once more after a network failure or timeout. The first try gets
   half of the budget.

- An unknown number is HTTP 404 with `{"status":"Error",…,"data":null}`, which the page reports
  as "No encontramos el envío … en nuestro sistema".
- Cloudflare's firewall in front of `blue.cl` refuses a client it scores as a bot with HTTP 404
  and the bare text `Not found`, and the site's pages put a browser check first. Both are read
  as a challenge. Another 404 page or a redirect is a moved route.
- The reply must name the number asked.
- Recognition makes the same request.

## Notes

- Scan clocks are a day and a time with no zone. Mainland Chile changes its clocks while
  Magallanes, where Blue Express also delivers, stays on one offset all year, and a scan does
  not say which region it was made in. So clocks stay local, without an offset. A scan the
  lookup lost the day of, written `NaN-NaN-NaN`, keeps no clock.
- Only scans with a title are listed, as on the page. The title is the description, in
  Spanish, and the code is kept. The location is the town or point the page names; the sender's
  announcement has none.
- Codes give the stage. A request to return the parcel to its sender (`SQ`, "En proceso
  devolución al remitente") holds the parcel as an exception until it is delivered or back with
  the sender: the delivery rounds after it carry the parcel back. New delivery details, the
  next working day's forecast and administrative incidents, which can follow a delivery,
  move nothing.
- The scans' street addresses and internal place codes are not kept.

## Limitations

- No estimate, delivery point, sender, recipient or proof of delivery. The page reads them
  from a second lookup, `POST /api/tracking`, which Cloudflare refuses outside a browser.
- The lookup may answer a failure of its own with the same 404 as an unknown number.
- No weight or service.

## Numbers

Blue Express tracks a shipment by its service order number (orden de servicio, OS), ten
digits. Ten bare digits are printed by many carriers and nothing in the number points to Blue
Express, so no rule claims them. The lookup does not find a shipment by the merchant's order
reference.

## Links

The tracking page `blue.cl/enviar/seguimiento?n_seguimiento=` followed by the number opens a
shipment. Older pages on `blue.cl`, `bluex.cl` and `tracking-unificado.blue.cl` take the same
parameter, and the first tracker used `tracking.bluex.cl/lctracking.asp?id=`.

## Testing

`npm run test:carriers:live -- carriers/blue-express`, with `BLUE_EXPRESS_TRACKING_NUMBER` and
optionally `BLUE_EXPRESS_UNKNOWN_NUMBER` set outside the repository.
