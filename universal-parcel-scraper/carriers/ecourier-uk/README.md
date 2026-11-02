# eCourier UK

eCourier UK parcels use enabled universal providers. There is no dedicated adapter.

eCourier, a Royal Mail company, is a London same-day courier that collects and delivers parcels and
documents within hours, including medical deliveries, and passes some jobs on to other carriers. Its
site is ecourier.co.uk. The `ecourier` entry is an unrelated courier in Bangladesh.

## Numbers

Its tracking guide gives eight-digit consignment numbers, which its FAQ calls docket references.
Eight digits are a shape other carriers' rules read, and no public number is known, so there is no
rule.

## Why there is no adapter

The tracker asks an open JSON service with the number alone, without a login or CAPTCHA, which
answers an unknown number with an empty list of jobs. A job passed on to another carrier links to
that carrier's tracker. No public number has shown a known delivery's reply yet. An adapter can
follow.

## Links

Tracking links carry the number as `consign_note` on the tracking page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
