# Correos de El Salvador

The Dirección General de Correos runs the national post of El Salvador. Tracks its items, its own
and the S10 items other posts send to El Salvador, through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://www.correos.gob.sv:8000/api/v1/rastrear-paquete/{number}`, as the
   script of the page at `correos.gob.sv/servicios/rastrear-paquete/` sends it. It needs no
   account, cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the service, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- A found item is HTTP 200 with the item under `envio`, a summary message and its scans newest
  first. `envio.numeroRastreo` must be the whole requested code; a reply for another code is
  inconclusive.
- A code the service does not know is HTTP 404 with an RFC 7807 problem titled `Not Found`; only
  that reply is not found. The page reads any 404 as an item not yet in the country, but the
  service answers a path it has no route for with an empty 404, and nginx answers one it does not
  pass on with its own page. Those, a 410 and a redirect are a moved route. A reply that reports a
  failure or holds no item is inconclusive; a 403 or a firewall page is a challenge.
- Recognition makes the same request. No detection rule offers Correos de El Salvador, so
  preflight does not ask it.

## Notes

- The service takes any thirteen characters, check digit or not. The adapter sends only whole S10
  codes with a valid check digit.
- Scans name IPS events in Spanish with their leg, `(salida)` in the posting country and
  `(entrada)` in the destination. The event name without its leg sets the stage, unknown wording
  goes to the shared rules, and the event type `idEvento` is kept as the code.
- A scan's `fecha` is a clock to the second, often with a fraction, and no zone. Its times of day
  fit UTC better than the offices' hours, so it is not read as Salvadoran time and stays
  `local_time`. The fraction orders scans in the same second and is then dropped.
- The summary message stages the item only when no scan does. The weight is kept in kilograms
  and the destination as a country code; mail from abroad comes without one.
- The page shows the item's class and origin country, which are not kept, nor are each scan's
  reason and action, which it does not show.

## Limitations

- The tracker has no ETA, service, sender, recipient, proof of delivery or delivery instant with a
  zone.
- The post's serials run densely, so a mistyped code whose check digit still holds can open
  another item, and the adapter cannot tell.

## Numbers

Its items carry UPU S10 numbers ending in SV. Inbound items keep the S10 number of the post
that sent them. Generic postal detection handles both, so no carrier rule claims the layout.
Mail from abroad reaches Correos de El Salvador when a caller names it, a provider names it, or
a result gives El Salvador as the destination of an S10 item. The samples and their sources are
in [`numbers.json`](numbers.json).

## Links

The tracker page sends the number from its form to the tracking service and draws the history
itself, so no address opens one parcel. The former tracker took the number in the path of a
`/rastrear-paquete/` address; the library still reads a number from that address, which now
opens the site's page-not-found.

## Testing

`npm run test:carriers:live -- carriers/correos-el-salvador`, with
`CORREOS_EL_SALVADOR_TRACKING_NUMBER` and optionally `CORREOS_EL_SALVADOR_UNKNOWN_NUMBER` set
outside the repository.
