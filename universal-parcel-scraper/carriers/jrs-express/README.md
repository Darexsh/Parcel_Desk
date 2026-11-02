# JRS Express

JRS Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

A JRS Express shipment is identified by the airbill number on its official receipt, usually six
digits, together with the receipt's branch code (BC) of three or four digits. The former
tracker took the two in separate fields; the current one takes them in one field joined by a
hyphen. Neither part is distinctive, so there is no detection rule.

## Links

The library reads a number from the `or` query parameter of `/track` on `jrs-express.com` and
`www.jrs-express.com`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
