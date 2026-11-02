# UTEC Logistics

UTEC Group is a Ukrainian freight forwarder. Its UTEC Express parcel line brought orders
from China into Ukraine and handed them to Ukrposhta.

## Retrieval

The public form's inline handler redirects to `utec.ua/tracking/{number}`. It bypasses the
form's declared POST action, so replaying that POST is not the tracking workflow.

TRAWL can open the tracking route through its browser protection. The route can return a generic
tracking template without a dated shipment reply. Opening
the page or echoing its address does not establish shipment existence or absence.

## Limitations

There is no validated native history parser. Use enabled universal providers for retrieval;
public reference provenance remains in `numbers.json`.

## Testing

Provider live-test inputs and commands are in the [provider READMEs](../../providers/README.md).
