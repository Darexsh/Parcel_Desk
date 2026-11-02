# Mobi Logística

Mobi Logística parcels use enabled universal providers. There is no dedicated adapter.

Mobi Logística (MOBI Logística Ltda), in Osasco, São Paulo, delivers bank and benefit cards and
small parcels across Brazil, with its own tracking system, iSiga. It was founded as iCourier. Its
site is mobi.com.br.

## Numbers

Its tracker takes a tracking code or order number. No public page shows one, so there is no rule.
Parcels it hands to Correios continue under a Correios number, which the tracker shows.

## Why there is no adapter

Each lookup needs the recipient's postcode (CEP) and a reCAPTCHA answer. One bank's cards ask for
the cardholder's name instead, also with a reCAPTCHA.

## Links

The tracker posts the code with the postcode and the CAPTCHA answer, so no address names one
parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
