# Zheldorexpeditsia

Zheldorexpeditsia (JDE) parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

A consignment is tracked by the sixteen-digit number of its forwarding receipt (ЭР), which the
tracker's input mask writes in four groups of four. Several other carriers share sixteen
digits and nothing in a JDE number points to JDE, so no rule claims it.

## Links

`i.jde.ru/track/?ttn={number}` opens the tracker for one consignment: its script reads the
number from the query and drops the dashes. The history loads by script after a captcha.

## Limitations

The tracker asks for a six-digit picture code before every lookup, and JDE's service refuses
the lookup until that code is solved. JDE's other public page, for a consignment's documents,
also asks for the four-digit PIN printed on the receipt, which consumers do not collect. JDE's
tracking API needs a customer account and JDE has no app of its own, so Zheldorexpeditsia
stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
