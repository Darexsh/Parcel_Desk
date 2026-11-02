# Correo Paraguayo

Correo Paraguayo parcels use enabled universal providers. There is no dedicated adapter.

Correo Paraguayo is Paraguay's postal operator. Its site is correoparaguayo.gov.py.

## Numbers

Its international items carry UPU S10 numbers ending `PY`, which postal detection reads; the layout of its
domestic numbers is not public. No public page shows either, so there is no rule of its own.

## Why there is no adapter

Its domestic tracker reads an open JSON endpoint without a key or CAPTCHA, which says when it has no data for a
number; its replies name the recipient. International items go to the UPU's tracker, which asks for a CAPTCHA.
No public number is known to see a found reply.

## Links

Its tracker has no address for a single number, so no link names it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
