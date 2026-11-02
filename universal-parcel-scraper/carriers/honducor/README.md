# Honducor

Honducor parcels use enabled universal providers. There is no dedicated adapter.

Honducor (Empresa de Correos de Honduras) is Honduras's national post, based at Toncontín airport
in Tegucigalpa. Its site is honducor.gob.hn.

## Numbers

Honducor gives items UPU S10 numbers ending `HN`, as its tracker's example shows. Generic postal
detection handles these numbers, so no rule for Honducor claims them.

## Why there is no adapter

Its tracker on rastreo.honducor.gob.hn is a plain page that reads the number from its address
without a session or CAPTCHA. It answers an unknown number as waiting for its provider rather
than as not found, and no public number has shown a known item's reply yet.

## Links

Tracking links carry the number as `tracking_number` on the tracker's `/rastreo` page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
