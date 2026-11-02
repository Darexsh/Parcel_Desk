# ETS Express

ETS Express parcels use enabled universal providers. There is no dedicated adapter.

ETS Express, 俄通收 (RETS), is a Harbin forwarder carrying e-commerce parcels from China to
Russia, many of them Ozon orders. Its site is ets-express.com.

## Numbers

It files a shipment under its own RETS code, `RETS`, twelve digits and `UES`, which
`ets-express-1` suggests at low confidence: the only public example is the one on its own
inquiry page. Its tracker also answers the Ozon posting numbers of the parcels it carries; those
stay with [Ozon](../ozon-logistics/README.md).

## Why there is no adapter

Its inquiry page reads a Hualei (华磊) tracker at `1.12.55.94:8082` over plain HTTP, the platform
[GZYL's adapter](../gzyl/hualei.ts) reads, without a session; it answered public numbers. An
adapter is possible and not yet written. Its event times carry no zone.

## Links

The inquiry page takes numbers in a form, so no portal link is published.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
