# Etomars

Etomars parcels use enabled universal providers. There is no dedicated adapter.

Etomars (이투마스), based in Seoul with a logistics centre in Incheon, ships online orders from
Korea to Japan under its SHIPNERGY brand, and to Taiwan and Southeast Asia. Sagawa delivers the
last leg in Japan, and Yamato or Japan Post some parcels, under their own numbers, which the
tracker shows. Its sites are etomars.com and shipnergy.com.

## Numbers

Its tracker takes the registration number: SN, nine digits and JP. These look like Japan Post's
UPU S10 numbers, but most fail the S10 check digit. Japan Post's rule claims the few that pass,
and `etomars-1` suggests Etomars for the rest at low confidence, since a mistyped postal number
fails its check digit too. The order numbers the tracker also takes stay unclaimed.

## Why there is no adapter

The tracker is a plain page that shows a registration number's history without a session, but
it keeps only the last three months. An adapter can follow.

## Links

Tracking links carry the registration number as `ids` on the tracker's result page, with
`mode=0`; other modes look up order and delivery numbers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
