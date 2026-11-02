# Correos de Cuba

Tracks items in the Cuban post's network through the tracker on correos.cu: Correos de Cuba's own
S10 items ending in CU, and items from abroad under the S10 number of the post that sent them.

The Empresa de Correos de Cuba runs the national post of Cuba.

## How it works

The [tracker page](https://www.correos.cu/rastreador-de-envios/) gives every visitor a token in a
hidden field. Its script posts the code, the year and that token to
`/wp-json/correos-api/enviosweb/`, which answers with the item's scans as JSON. The adapter does
the same with the current year in Havana, which the page fills in. It keeps the token for later
lookups and reads the page again once when the tracker refuses it. A request that fails to reach
the tracker, or hangs, gets one more try.

## Notes

The tracker matches the whole code and nothing shorter or longer, so its reply, which does not
repeat the code, belongs to the code asked. A year finds items with scans in it or the year before.

Each scan has a state, a date and two offices. The page places a received item at the office that
received it and the other scans at the office they left, and names the destination country in
place of the export office; the adapter does the same. The states have no codes; posting,
customs, release from customs and delivery have their own. Dates are Cuban wall clocks without a
zone and stay local.

## Limitations

A code with no scans this year or last gets the same empty answer as one the tracker never saw,
so it is a `NoHistoryError`, inconclusive rather than not-found. The countries above the history
are in Spanish and do not always name both ends, and the progress rail repeats the states, so
neither is kept. The page's hint about ten-digit DHL numbers is not supported.

## Numbers

Its items carry UPU S10 numbers ending in CU. Inbound items keep the S10 number of the post
that sent them. The issuer of an S10 code does not establish who delivers it, so detection keeps
codes ending `CU` with the generic postal carrier. `correos-cuba-s10`, at low confidence, makes
preflight ask Correos de Cuba about them first. Mail from abroad reaches Correos de Cuba when a
caller names it, a provider names it, or a result gives Cuba as the destination of an S10 item.
The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker asks for the number and the year of posting and loads the history with a script, so no
address opens one parcel.

## Live test

Set `CORREOS_CUBA_TRACKING_NUMBER` outside Git and run
`npm run test:carriers:live -- carriers/correos-cuba/adapter.live.test.ts`. For an item from
before last year, also set `CORREOS_CUBA_TRACKING_YEAR` to a year that finds it. Optionally set
`CORREOS_CUBA_UNKNOWN_NUMBER` to check an inconclusive empty answer.
