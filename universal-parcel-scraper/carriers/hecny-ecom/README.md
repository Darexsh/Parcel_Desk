# Hecny E-com

Hecny E-com parcels use enabled universal providers. There is no dedicated adapter.

Hecny E-com is the cross-border parcel service of Hecny Group CIS, the Russian arm of the Hecny
forwarder, carrying marketplace parcels from China and Turkey to Russia through customs to
Russian last-mile partners. Its tracker moved to ecom.yolka.io, run by Hecny's IT affiliate.

## Numbers

No public page shows a Hecny E-com number, so there is no rule.

## Why there is no adapter

The tracking page posts the number to an open JSON service without a session or CAPTCHA, which
answers an unknown number with a not-found message. No public number is known to see a found reply.
Its reply carries the recipient's address, which an adapter would have to leave out.

## Links

Each parcel has its own page, `/parcels/<number>`, on ecom.yolka.io and formerly on e-com.hecny.ru.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
