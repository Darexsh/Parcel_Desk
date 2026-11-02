# Intercourier

Intercourier parcels use enabled universal providers. There is no dedicated adapter.

Intercourier is a Portuguese express courier.

## Numbers

The tracking form's examples are twelve-digit shipment numbers, and an earlier version of the
form gave another of the same length. Twelve bare digits are shared with many carriers, so no
rule claims them.

## Links

The tracking page at `intercourier.pt/pt/tracking` (or `/en/tracking`) is a GET form that reads
a `tracking` parameter and opens one parcel.

## Why there is no adapter

The tracking page answers a GET with server-rendered HTML, with no token or CAPTCHA. An unknown
number, the form's examples included, gets "Não encontrámos correspondências para o código de
envio". No public page shows a current shipment number, so a found reply has not been seen.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
