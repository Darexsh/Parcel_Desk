# CST Italia

CST Italia parcels use enabled universal providers. There is no dedicated adapter.

CST Corriere Espresso, run by CST Italia from Rome, is an Italian express courier that delivers
e-commerce parcels, many of them sent from China. It traded as BDM Network before: its tracking
page links BDM Network's review page and its customer-service line is BDM Network's.

## Numbers

Shipment numbers are three letters followed by 18 or 22 digits. Current numbers start with
`CST`, as the tracking page says; BDM Network's numbers started with `BDM`. Customer reviews
give both prefixes in both lengths, and BDM Network replied to some of the `BDM` ones.
`cst-italia-1` claims the `CST` layouts and `cst-italia-2` the `BDM` layouts; no other carrier
rule matches them.

## Links

The tracking page sends the number to the site by script, so no address opens one parcel.

## Why there is no adapter

The tracking page posts the number as `idSpedizione` to `/ajax-tracking` on the same site, with
no token or CAPTCHA; the page's reCAPTCHA is commented out. The page reads a JSON list of scans,
each with `DataConsegna`, `OraConsegna` and `Causale`. That service answers every number, a CST
number or not, with `IdDescrizione` 99 and a database error naming an ambiguous column, so an
adapter needs it to answer again and a current number to confirm its reply.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
