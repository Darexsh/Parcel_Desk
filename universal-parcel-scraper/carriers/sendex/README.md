# Sendex

Sendex is a Mexican parcel network that now trades as Sendex by Coordi, in alliance with
Coordinadora. Tracked through its tracking page's own form.

## How it works

1. `direct`: one `POST https://sendex.coordi.com/rastreo/` with the form body `guias={number}`,
   as the tracking page's form sends it. The page renders the guía on the server: a card with
   the guía and its type, the recipient and destination, the service and two dates, then the
   movements oldest first and who received a delivered parcel. It needs no cookie, token,
   CAPTCHA or browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A guía the tracker does not hold gets "No se encontraron resultados para las guías
  ingresadas." in place of the card, which is the only missing guía. The page's connection
  error notice is inconclusive. A redirect, a 404, a page without the results and results for
  another guía are no answer. Block pages are challenges, and rate limits and other HTTP errors
  keep their own failure kinds.
- The card must show the guía asked. The tracker refuses fewer than twelve digits, so a part of
  a guía finds nothing.
- The form takes several guías, one per line; the page then shows one and loads the others
  through `admin-ajax.php` with a nonce from the page. The adapter sends one guía and needs
  neither.
- Recognition makes the same request.

## Notes

- Each movement has an office, a day with a clock to the minute, and a wording. Mexico has
  several zones and the page names none, so the clocks stay `local_time`. The result lists the
  movements newest first and keeps a movement the page lists twice once.
- Older guías have sentences ("EL ENVÍO SALIÓ HACIA LA OFICINA DESTINO O DE ENLACE"), newer
  ones short labels ("EN TRÁNSITO"). The wording stages a movement through
  [status.ts](status.ts), and wording the map does not know goes to the shared wording rules.
  "ENVÍO SALE DE COP" can repeat daily at the delivering branch before the delivery round, so
  it is transit.
- `Tipo de Servicio` is the service name, and the country the destination country. The
  commitment date (`Fecha Compromiso`) is the estimate until the delivery, when the page fills
  it.
- The recipient's name, state, city and postcode, who received the parcel, the guía's type, the
  kind of shipment and the documentation date are not kept.
- The former site on `www.sendex.mx` still answers `/Home/RastreoRapido?guias={number}` with
  the guía as JSON, movement ids included, without a cookie or token. The adapter reads Sendex
  by Coordi's tracker instead.
- The page names no other carrier, so there is no hand-off. Eleven-digit guías are
  Coordinadora's: the page sends them to Coordinadora's tracker, and the adapter rejects them
  as invalid input.

## Limitations

- No weight, proof of delivery or instants.

## Numbers

Sendex guías are twelve digits. Its tracking page asks for the twelve digits and sends
eleven-digit guías to Coordinadora's tracker instead. The guías seen in archived lookups on
Sendex's former tracker all end in `001` and a final digit. Twelve bare digits are printed by
many carriers and nothing in the number points to Sendex, so no rule claims them, and a guía
reaches the adapter when it is filed under Sendex. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The current tracking page posts its form and has no address for one parcel. The former site on
`sendex.mx` opened one with `/Home/RastreoRapido?guias=` and earlier with `/Rastreo/Rastreo/`
followed by the number. Those addresses are read but no longer built: Sendex by Coordi tracks
on `sendex.coordi.com`.

## Testing

`npm run test:carriers:live -- carriers/sendex`, with `SENDEX_TRACKING_NUMBER` and optionally
`SENDEX_UNKNOWN_NUMBER` set outside the repository.
