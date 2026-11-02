# Zeleris

Tracks Zeleris shipments in Spain through the shipment page of Zeleris's own website.

## How it works

The tracking form on `www.zeleris.com/seguimiento-de-envios/` opens
`/detalle-de-envio/?tracking_number=<code>`, which the site's WordPress plugin renders on the
server. The adapter reads that page with one GET and does not follow its redirects. No account,
cookie, nonce, CAPTCHA or browser is needed. A request that fails to reach Zeleris is sent once
more within the budget.

A known code gets the shipment page: "Pedido" and the code it answers for, the progress rail and
the messages shown to the recipient, newest first, each with a date and a minute. An unknown code
is redirected to the search page with `not_found=1` and the code, which is the only missing
shipment. A redirect with `tracking_error=1` ("estamos teniendo un problema técnico") and any
other redirect stay inconclusive, as do a search page served in place of the shipment and HTTP
404. Block pages, rate limits and other HTTP errors keep their own failure kinds. Recognition uses
the same lookup.

## Numbers

A Zeleris code is eight hexadecimal characters, nine digits and a letter, which `zeleris-1`
claims. Anything else is invalid without a request. References of `ES`, a year, `COM` and ten
digits are [Packlink](../packlink/README.md)'s bookings, not Zeleris numbers.

The hexadecimal part is a nine-digit number whose third to seventh digits are a day of the year
and a year. Zeleris ignores those five digits in a lookup and prints the code with its own
admission date, which is often a day after the label's. The page is accepted when it names the
requested code or one that differs only there, and that printed code is reported as
`canonical_tracking_number`. Changing any other part, such as the first two digits, the last two
or the letter, gives not found.

## Notes

- The messages carry no code. Their sentences are mapped whole in [status.ts](status.ts); others go
  to the shared wording rules. The first message ("Tu envío ya esta preparado. Te avisaremos cuando
  este en camino.") is the scan the older tracker called "RECEPCION TRANSPORTE", at the same clock,
  so it is `accepted`, not the transit its "en camino" would suggest. A text message to the
  recipient moves nothing.
- The rail's current step is the shipment's state, which moves without a message: a parcel at its
  destination depot can show only its admission, and a final non-delivery has no message of its
  own. The rail can also stay in transit while a delivery round's message is newer. The current
  stage is whichever of the rail's step and the newest message is further along. The delivered
  step's date and time repeat the delivery message and are dropped.
- Clocks are wall clocks without an offset and are kept as local times. The page names no place,
  sender, recipient, weight or estimated delivery.

## Limitations

Only the plain code is supported. The page's advanced searches by depot code, expedition number
and date, or by sender reference and date, are not used. A message or rail step the maps do not
know stays without a stage, or leaves the stage to the messages.

## Links

The link opens the shipment page for the code; pasted links to it with or without the trailing
slash are read too.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.
Explicit absence redirects must name the whole requested number on the carrier’s tracking site.
A bot check on the redirected page stays a challenge.

## Live test

Set `ZELERIS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/zeleris/adapter.live.test.ts`.
Optionally set `ZELERIS_UNKNOWN_NUMBER` to check a code Zeleris does not know.
