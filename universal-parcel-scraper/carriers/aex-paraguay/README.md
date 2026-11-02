# AEX

AEX (COPASSA S.A.) is a Paraguayan courier that collects and delivers parcels across the country
for shops and other senders. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://www.aex.com.py/web/tracking.php?guia={guía}`, the address the
   page's own form sends the guía to. The server renders the history in the page. It needs no
   cookie, token or browser.
2. `retry`: one more try after a lookup that fails to connect or hangs. The first try gets half
   of the budget.

- A guía the tracker does not hold gets "No se encuentra el número de seguimiento que
  ingresaste.", which is the only missing guía. A guía whose series the tracker does not issue
  gets the empty search form under an empty heading, which is invalid input. A redirect, a 404,
  a page without the history card and a page for another guía are no answer; block pages are
  challenges, and rate limits and other HTTP errors keep their own failure kinds.
- The card's heading repeats the guía asked, in capitals and without spaces. It is the only
  identity on the page and must match the whole guía.
- Recognition makes the same request.

## Notes

- Events are grouped under a heading for each day, such as "Martes, 05 de Diciembre del 2023",
  and each has a clock to the second. The page names no zone, so the clocks stay `local_time`.
- Each event has the guía's state, such as "Entregada", and the event itself, such as "Entrega
  Realizada". The event is the description; the state describes it only when the event is empty.
  The event, then the state, stages it through [status.ts](status.ts), and wording the map does
  not know goes to the shared wording rules. The reception at an AEX office can be listed before
  the collection from the sender; both accept the parcel.
- The progress rail above the events repeats what they say, and is not read.
- A comment under an event names whoever took a delivery and their ID number. Comments are not
  read, and events lose phone and ID numbers.

## Limitations

- No location, delivery estimate, weight or proof of delivery, and no instants.

## Numbers

A guía is a series of up to three characters starting with a letter, then six to eighteen
letters and digits, as AEX's API documentation sets them. Most series are reserved by AEX (`A`,
`C`, `E1`, `FED`, `ML`, `P`, `RP`, `RR`, `TNT`); senders can register their own. Guías seen on
the tracker are the letter `A` and nine digits. Detection does not offer AEX, since that shape
falls inside Allegro One's rule. A guía filed under AEX reaches the adapter, which takes a letter
and six to twenty letters and digits. The sample records are in
[`numbers.json`](numbers.json).

## Links

The tracker at `www.aex.com.py/web/tracking.php` reads the guía from `guia`. Archived lookups
also open one at `/web/tracking/` followed by the guía, which now redirects to the home page.

## Testing

`npm run test:carriers:live -- carriers/aex-paraguay`, with `AEX_PARAGUAY_TRACKING_NUMBER` and
optionally `AEX_PARAGUAY_UNKNOWN_NUMBER` set outside the repository.
