# Correos de Nicaragua

Correos de Nicaragua parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Correos de Nicaragua gives letters, parcels and EMS items UPU S10 numbers ending in `NI`.
Generic postal detection handles these numbers, so no rule for Correos de Nicaragua claims
them. Its small-packet and parcel lookups take other references, such as a receipt number,
which stay unclaimed.

## Links

The tracker on rastreo.correos.gob.ni posts the number and has no address for one item.

## Why there is no adapter

The tracker's form posts the number together with the answer to a Google reCAPTCHA checkbox, and
the result page is drawn on the server from that post. Sent without a solved answer, every number
gets the form back with "El parametro enviado es inválido" in the captcha's error slot. Its
small-packet and parcel lookups carry the same checkbox, and the post publishes no mobile app,
so Correos de Nicaragua stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
