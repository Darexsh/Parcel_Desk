# CargoLine

CargoLine parcels use enabled universal providers. There is no dedicated adapter yet.

CargoLine is a cooperation of German general-cargo forwarders. Cepra is its tracking system and
customer portal, not a carrier of its own.

## Numbers

A colli number is `00` and the shipping partner's SSCC, which every GS1 shipper prints, so no
rule names it. The tracker also takes a partner number with that partner's reference.

## Tracker

The public tracker answers a colli number without a login or CAPTCHA. A found lookup moves to an
address that adds the recipient's postcode; an unknown one goes back to the form.

## Links

The tracker keeps the colli number in the path, sometimes followed by the postcode, which the
link rule leaves out.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
