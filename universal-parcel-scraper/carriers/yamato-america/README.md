# Yamato Transport U.S.A.

Yamato Transport U.S.A. parcels use enabled universal providers. There is no dedicated adapter.

Yamato Transport U.S.A., Inc. is Yamato Holdings' subsidiary in the United States. It carries
International TA-Q-BIN parcels from the United States and Canada to Japan, where Yamato Transport
delivers them, and runs moving and freight services. Its site is yamatoamerica.com.

## Numbers

Its slips are twelve digits with Yamato's check digit, as Yamato Transport's are in Japan, so no
rule names it: [`yamato-1`](../yamato/README.md) suggests Yamato Transport for both. Yamato
Transport's domestic tracker does not hold the slips, and its inbound tracker for parcels from
abroad can show a different domestic slip for the same parcel.

## Why there is no adapter

The tracker's own lookup answers without a key or CAPTCHA, but no public slip it still knows has
been found.

## Links

The tracker opens a slip from its `slipnumber` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
