# Copa Airlines Courier

Copa Airlines Courier is the door-to-door courier service of Copa Airlines, based in Panama
with offices across Latin America, the Caribbean and the United States. In Cuba, Correos de
Cuba delivers its parcels under its own numbers. Tracked through the tracking form on its
home page.

## How it works

1. `direct`: `GET https://www.copacourier.com/` for the tracking form's anti-forgery token and
   the cookie it is bound to, then `POST https://www.copacourier.com/Hawb/Hawb` with the form
   body `txtNumeroHAWB={number}` and the token, as the form sends it. No key, captcha or
   browser is needed. The server renders the HAWB's box with its milestones, oldest first.
2. `retry`: one more attempt in a new session when the first fails to reach the site or hangs.
   The first gets half of the budget, so the retry fits in the rest.

- An unknown HAWB is HTTP 200 with a notice that the code is not in the tracker's database,
  which is not found. The tracker refuses a HAWB in lower case as malformed; the adapter sends
  it in capitals, so that notice means the request changed. A token the site does not accept
  is an empty HTTP 400, which is inconclusive. A 404 or a redirect is a moved route.
- The tracker matches the whole HAWB only: the digits without the `H`, or a wildcard, find
  nothing. The box must name the HAWB asked.
- The page's month names follow `Accept-Language`, so the adapter asks for Spanish, the site's
  own language.
- Recognition makes the same requests.

## Notes

- Each milestone has a wall clock to the minute with no zone, its wording and the airport code
  of its station, as `RECIBIDO EN PUNTO DE TRÁNSITO - PTY`. Stations sit in several zones and
  the page names none, so clocks stay `local_time`. The description is the wording alone; the
  location is the station's town for codes seen in replies, and the code itself for others.
  Customs and distribution milestones carry no station.
- Milestones within one minute are not always listed in order: the van can come after the
  delivery it brought. Those are ordered by progress, then by the page's order.
- A parcel for a Cuban province outside Havana goes to Correos de Cuba after customs. Its
  history ends at customs, or at `ENTREGA EN AREA REMOTA` once Copa Courier hands it on, which
  stays in transit. The page names neither Correos de Cuba nor its number, so there is no
  hand-off.
- The weight is kept. The origin and destination towns and the package count are not, nor is
  the delivery row's detail line, which names who took the parcel and their identity card
  number.

## Limitations

- No estimate, no service and no delivery time as an instant.
- Histories of parcels Correos de Cuba delivers stop when Copa Courier hands them over.

## Numbers

Copa Courier tracks house air waybills (HAWB). Customers quote them as `H` followed by seven
digits, which `copa-courier-1` suggests with low confidence because GLS and Loggi rules for any
eight-character code also match that shape. Recognition asks the tracker about them. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracking form posts the HAWB number, so no address opens one parcel.

## Testing

`npm run test:carriers:live -- carriers/copa-courier`, with `COPA_COURIER_TRACKING_NUMBER`
and optionally `COPA_COURIER_UNKNOWN_NUMBER` set outside the repository.
