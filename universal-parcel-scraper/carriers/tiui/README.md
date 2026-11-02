# Tiui

Tiui parcels use enabled universal providers. There is no dedicated adapter.

Tiui, run by Tiui Soluciones, S.A.P.I. de C.V. in Mexico City, delivers online shops' orders cash on
delivery with its own couriers in Mexican cities such as Mexico City, Guadalajara and Monterrey, and
offers fulfilment. Its site is tiui.mx.

## Numbers

Its tracker takes the folio: three groups of up to four, three and six digits joined by hyphens, the
first being the merchant's. One public folio is known. Without its hyphens a folio is a run of
digits that many carriers' rules read, so there is no rule.

## Why there is no adapter

The tracker asks an open JSON service without a session and answers with the shipment's movements
and their exact times. Its replies also hold the sender's and recipient's personal details, which an
adapter must drop. An adapter can follow.

## Links

Tracking links carry the folio after `/rastreo/` in the tracker's address.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
