# Paket

Paket parcels use enabled universal providers. There is no dedicated adapter.

Paket is a Chilean last-mile company delivering in the Santiago Metropolitan, Valparaíso and O'Higgins regions.
Shipments it books to the rest of Chile travel with Starken under Starken's numbers. Its site is paketex.com.

## Numbers

Its tracker takes four to twelve digits. No public page shows a Paket number, and short runs of digits are
shared by other carriers, so there is no rule.

## Why there is no adapter

Its tracker reads an open JSON endpoint without a session or CAPTCHA, which answers an unknown number with a
404 and masks the recipient's details. No public number is known to see a found reply.

## Links

The tracker opens numbers from its `id` parameter. Links in Paket's text messages put a signature and a dot
before the number; the library reads only the number after the dot.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
