# Andreani

Andreani is Argentina's largest private parcel carrier. It delivers online orders and
business shipments across the country, to the door or to its branches. Tracked through the
lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://tracking-api.andreani.com/api/v3/Tracking?payload={payload}`, as
   the tracking page's script sends it. The payload is the query
   `{"idReceptor":1,"idSistema":1,"userData":"{\"mail\":\"\"}","numeroAndreani":"{number}"}`
   under AES-256-CBC, in Base64, with the key and IV the script's public settings give every
   visitor. The request carries the static token the script sends as `Authorization`. It needs
   no cookie, session or browser. The JSON reply has the parcel's current milestone and every
   milestone with the scans the page lists under it.
2. `retry`: the same request once more after a network failure or timeout. The first try gets
   half of the budget.

- An unknown number is HTTP 206 with `null`, which the page reports as "No se encontraron
  resultados". A 404 or a redirect is a moved route.
- Andreani's web firewall answers a request it blocks with HTTP 500 and a block page, read as a
  challenge. A JSON 500 is a failed lookup.
- The service answers any text, and an unrelated input can bring back another shipment. The
  reply must echo the number asked.
- Recognition makes the same request.

## Notes

- Scan clocks are Argentina's wall clock with no offset. The delivery time the reply writes
  into its own summary sentence matches the delivery scan's clock. Argentina has a single zone
  without daylight saving, so the clocks are read in Buenos Aires time and get `-03:00`.
- A scan's description is its line as the page shows it, in Spanish, with the HTML as text.
  A line stages the scan, else the milestone it sits under, else the shared wording rules.
- A current milestone that ends the journey, such as `Entregado`, decides the stage. Otherwise
  the newest scan does.
- The scan's branch is its location.
- Phone and identity-card numbers are stripped from lines. The sender, the merchant's account,
  the delivery round's driver and coordinates, the help texts and the remarks in the reply are
  not kept.

## Limitations

- No estimate: the reply words it as a sentence without a year.
- Only the history the page shows to a visitor who is not logged in.
- No weight, service or scan code.
- `www.andreani.com` blocks some networks outright, while the tracking service behind it still
  answers them.

## Numbers

Andreani shipment numbers are fifteen digits starting `36000`, `31000` or `30000`. Lookups
archived from Andreani's tracker and from the tracking service behind it show all three, and no
other carrier's known numbers start that way, so `andreani-1` suggests Andreani for them at low
confidence: BRT and Yunda print fifteen digits too, and recognition asks the candidates. Older
lookups also show fifteen digits starting `90000` and lettered references of merchants, which
stay unclaimed.
The tracker also knows numbers of a `G` and fourteen digits and of a `U` and eight digits.

## Links

Andreani's notification emails link one shipment at `andreani.com/envio/{number}`, and archived
lookups use the same path on `seguimiento.andreani.com`. The library reads the number from those
addresses but builds none, because the site blocks automated checks of its search page.

## Testing

`npm run test:carriers:live -- carriers/andreani`, with `ANDREANI_TRACKING_NUMBER` and
optionally `ANDREANI_UNKNOWN_NUMBER` set outside the repository.
