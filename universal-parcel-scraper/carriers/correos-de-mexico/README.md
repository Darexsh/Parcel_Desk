# Correos de México

Tracks Correos de México items, its own and those other posts send to Mexico, through Correos de
México's own tracking page.

## How it works

The [tracking page](https://www.correosdemexico.gob.mx/SSLServicios/SeguimientoEnvio/Seguimiento.aspx)
is an ASP.NET WebForms page. It answers for one year at a time, chosen in its "Ejercicio" selector,
and files each event under the year it happened. Each row carries, in an unheaded white column, the
event's place in the item's whole history. One lookup:

1. `GET Seguimiento.aspx?guia=<number>`, the page's own address for a number, renders that number's
   events of the current year.
2. While the history does not reach its first event, posts the page's form back for the next older
   year the selector offers, with the hidden view state and event validation of the page before, as
   the search button does. A post without them fails with HTTP 500.

No account, key, cookie, CAPTCHA token or browser is needed; the page's reCAPTCHA guards only its
notification signup. An older year's events join the history only when they come before the later
year's. A lookup that fails to reach the site is tried once more within the budget.

The page must answer for the whole requested number and the year asked, with the history's five
columns and an event count that matches its rows. The no-information notice naming the number, for
every year offered, is the only missing item. The maintenance page, or a redirect to it, is
inconclusive, and so is any other redirect or notice. Block pages, HTTP errors and malformed pages
keep their own failure kinds. Recognition uses the same lookup.

## Numbers

The tracker follows S10 item codes, and the adapter takes them with a valid check digit from any
country; anything else is invalid without a request. A code ending `MX` is Correos de México's, but
the issuer of an S10 code does not establish who delivers it, so detection keeps such codes with
the generic postal carrier and the low-confidence `correos-de-mexico-s10` rule makes preflight ask
Correos de México about them. Mexpost and registered items use the same layout; no other domestic
layout has been seen.

## Notes

Each scan has a date, a wall clock, an office and a Spanish event name without a code. An office
in Mexico ends with its state's abbreviation. Since Mexico dropped summer time, the states wholly
on central time keep UTC−6 all year, so their offices' scans are dated on Mexico City's clock.
Offices in other states, in states with several clocks, without a state, such as the office of
exchange, and abroad, where foreign posts' scans come through with their own clocks, are kept as
local times. Rows are ordered by their clocks, as the event numbers sometimes put a scan before one
made minutes earlier.

Foreign posts' events use the same names, so an arrival abroad is worded as an arrival in Mexico.
The map reads these names; the shared wording rules read most of them as no milestone. Wording the
map does not know goes to the shared rules. After "Pieza devuelta", the item goes back to its
sender, so its later counter wait and delivery are its return. The pickup point is the office
whose counter the item waits at, while it waits there or once it was collected there. Who received
the item, the query time and the page's notices are not read.

## Limitations

The page has no estimated delivery date, service name, weight or proof of delivery, and its clocks
have no offsets. The selector offers only the last few years, so the earlier events of an older
item can be gone; such a history is marked truncated. Ordinary items, the page warns, are not
tracked after they arrive.

## Links

The page's own address with `?guia=` opens one item's current year. Links to it, and to the older
`seguimientoportal2.aspx` page, are recognized.

## Live test

Set `CORREOS_DE_MEXICO_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/correos-de-mexico/adapter.live.test.ts`.
Optionally set `CORREOS_DE_MEXICO_UNKNOWN_NUMBER` to check a number without information.
