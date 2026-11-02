# Arrow Express

Arrow Express parcels use enabled universal providers. There is no dedicated adapter.

Arrow Express is a Malta courier and forwarder in Marsa, part of Mariner Services, carrying express and
air freight to and from Malta. It is not [Arrow XL](../arrow-xl/README.md), and has no bare "Arrow" alias.

## Numbers

Its numbers are numeric house air waybills of unknown length, and no public page shows one, so there is no
rule.

## Why there is no adapter

The tracking box on its home page runs on Laravel Livewire and needs the page's session token. Its older
public tracker, `tracking.arrow-express.eu/common/track_trace.php`, takes a form `POST` of `hawb` and
returns HTML; it pads the number to fifteen digits and says "No information found for this shipment" for an
unknown one. Neither has a per-shipment address, and no public number is known to see a found reply.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
