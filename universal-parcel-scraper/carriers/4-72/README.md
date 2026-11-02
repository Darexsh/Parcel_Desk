# 4-72

Tracks the items of 4-72, Servicios Postales Nacionales, Colombia's national post, and the mail
other posts send to Colombia, through the two requests its tracking page makes.

## How it works

1. `direct`: `GET https://svc2.sipost.co/TrazabilidadWeb/Traceability/Search?guia=<guía>` and
   `GET …/Traceability/Events?guia=<guía>` at once, as the page at `svc2.sipost.co/TrazabilidadWeb`
   asks for them. They need no account, cookie, token, key or browser. The first answers the
   shipment's card as an HTML fragment, the second a table of its scans.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The card's heading must name the whole guía asked for. An empty card, which the page reports
  as "No se ha encontrado información de la guía", with a scan table without rows, is not found.
  Scans without a card, or a card without scans, are inconclusive.
- Recognition makes the same requests.
- A 429 is a rate limit, a 403 or a bot check a challenge, and a redirect or a 404 a moved route.

## Notes

- The scan table gives the scan's clock, the operating centre, the event and a remark. The
  events come without a code, so the map reads their wording. A remark, such as why a visit did
  not deliver, follows the event without digit runs that could be a phone or ID number; a
  delivery's remark is not read.
- After a delivery, the signed delivery document travels back to the sender under the same
  wordings as a returned item. Return scans after a delivery are left out, so the item stays
  delivered. `Digitalizado`, the signed document scanned, moves nothing.
- Clocks are the operating centres' wall clocks, without a zone, some on twelve hours. No relay
  giving the same scans with offsets was found, so every scan keeps its wall clock. Colombia keeps
  one zone all year, so they read the same in the catalog zone.
- The service is the card's own name for it, without the tariff's year some services carry. The
  card's sender, recipient, receiver, postage, weight, whose unit it does not state, and linked
  guías are not read.

## Limitations

- The tracker has no ETA, no event codes and no clock with an offset.
- The adapter takes only S10 codes with a valid check digit.

## Numbers

4-72's guías are UPU S10 numbers with the `CO` suffix, and it also tracks inbound S10 items
from other posts. Generic postal detection keeps S10 numbers, and a code ending `CO` with a
valid check digit only suggests 4-72, which recognition asks first.

## Links

`svc2.sipost.co/TrazabilidadWeb` reads the guía from `?guia=`, and 4-72's own tracker builds
that address. `ReportTrace` on the same host opens the delivery certificate, and
`enviosonline.4-72.com.co` reads the guía from `?guia=` on `rastrear.php`.

## Testing

`npm run test:carriers:live -- carriers/4-72`, with `FOUR_SEVENTY_TWO_TRACKING_NUMBER` set
outside the repository. Optionally set `FOUR_SEVENTY_TWO_UNKNOWN_NUMBER` to check a guía the
search does not know.
