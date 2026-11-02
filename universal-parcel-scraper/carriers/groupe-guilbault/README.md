# Groupe Guilbault

Groupe Guilbault shipments use enabled universal providers. There is no dedicated adapter.

## Numbers

Guilbault's public trace finds a shipment by its order number or its bill of lading. The
carrier's own web-order guide shows a six-digit invoice number as the number to search with.
Six digits are shared by many carriers' references, so no rule claims them; a caller names the
carrier. Bills of lading are the shipper's own references and are not recorded.

## Links

Guilbault's trace page posts the number in a form to `external_bill_viewer.msw`, so no address
opens one shipment and the library reads no link.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
