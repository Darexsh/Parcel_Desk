# Celeritas

Tracks Celeritas e-commerce deliveries and returns in Spain and Portugal through the tracking
page of Celeritas's own website.

## How it works

`celeritastransporte.com/seguimiento-paquete-pedidos/?refer=<reference>&lang=es`, the address
links to one shipment use, renders the shipment on the server. The adapter reads it with one GET
and does not follow redirects. The form on the same page posts the lookup with a WordPress nonce;
the address needs no nonce, cookie, CAPTCHA or browser. `lang=es` keeps the Spanish wording the
status map knows. A request that fails to reach Celeritas is sent once more within the budget.
Recognition uses the same lookup.

A known reference gets a details list, a heading over the scans and the scans, newest first, each
with a date and a minute, a wording and an explanation. The adapter reads the reference, the
weight, the heading and each scan's clock and wording. An unknown reference gets the notice "Esta
referencia no existe", which is the only missing shipment. Another notice, the page without a
lookup, a redirect and HTTP 404 stay inconclusive. Block pages, rate limits and other HTTP errors
keep their own failure kinds.

After an identified browser challenge, `trawl` opens the same tracking address in the
configured browser service. The carrier parser checks the whole shipment identity.
Definite answers, rate limits and malformed replies do not launch a browser.
Recognition stays HTTP-only.

## Notes

- The tracker also finds a shipment by the shop's order number, and then names the shipment's
  own reference. A page is accepted only when its reference is the requested one; a hit under
  another reference is inconclusive.
- The wordings carry no code. They are mapped whole, with or without accents, in
  [status.ts](status.ts); others go to the shared wording rules. The heading "ENVIO DEVUELTO"
  makes the shipment returned even when a cross-dock scan follows the return; "EN GESTION" leaves
  the stage to the newest scan. The explanation under each wording is the same for every parcel
  and is dropped.
- Clocks are wall clocks without an offset and are kept as local times, since the network covers
  both Spain and Portugal.
- The details list also names the shop, the shop's order number, the carrier that delivers, the
  order date, the origin and destination towns, the Celeritas Point and the parcel count. None of
  them is read. The delivering carrier comes without a number of its own, so there is no
  hand-off. The point is the one the order was routed to, or where a return was dropped off, and
  a parcel that misses it waits at the agency instead, so it is not given as a pickup point.
- The site answers bursts of lookups with HTTP 429 and a Cloudflare challenge.

## Limitations

Only nine-digit references are taken; shop order numbers are not looked up. A wording or heading
the maps do not know stays without a stage, or leaves the stage to the scans.

## Numbers

The tracker's reference (número de referencia) is nine digits, for deliveries and return
pickups alike. Nine bare digits are shared with TNT and many other carriers, so no rule claims
them. The tracker also shows the shop's own order number, which is not a Celeritas number.

## Links

The link opens the tracking page for the reference. Pasted links to it with `refer` are read too.

## Live test

Set `CELERITAS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/celeritas/adapter.live.test.ts`.
Optionally set `CELERITAS_UNKNOWN_NUMBER` to check a reference Celeritas does not know.
