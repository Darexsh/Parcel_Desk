# BARQ

BARQ parcels use enabled universal providers. There is no dedicated adapter.

BARQ, also called BARQ Fleet, is a Riyadh delivery company that brings online orders within hours
inside Saudi cities such as Riyadh, Jeddah, Dammam, Mecca and Medina, for merchants on platforms
such as Salla and Zid. Its sites are barqapp.com and barqfleet.com.

## Numbers

Its help centre says tracking numbers are two letters and nine digits. No public number is known,
and other carriers' rules read that shape too, so there is no rule.

## Why there is no adapter

The tracker asks an open GraphQL service without a session or CAPTCHA, which answers an unknown
number as invalid. Its answer also carries the courier's live position, which an adapter would leave
out. No public number has shown a known order's reply yet. An adapter can follow.

## Links

Tracking links carry the number as `trackingId` on the English or Arabic tracking details page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
