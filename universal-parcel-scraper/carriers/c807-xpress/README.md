# C807 Xpress

C807 Xpress parcels use enabled universal providers. There is no dedicated adapter.

C807 Xpress is the parcel division of C807 Operador Logístico, a logistics company based in Antiguo
Cuscatlán, El Salvador. It collects and delivers online orders in El Salvador, Guatemala and
Honduras, and runs a Miami mailbox for purchases from the United States. Its site is c807xpress.com.

## Numbers

Its El Salvador help pages ask for the guide number as six letters or digits, two digits and ten
digits, separated by hyphens; its Honduras pages give three, four and ten digits. No public guide is
known, and without the hyphens both layouts read as other carriers' numbers, so there is no rule.

## Why there is no adapter

The tracking page posts the guide number to an open JSON service without a login or CAPTCHA, which
answers an unknown number with an error code. Its reply also carries the recipient's name and
address, which an adapter would leave out. No public guide has shown a known parcel's reply yet. An
adapter can follow.

## Links

The tracking page reads the guide number as `guia` from its address, but its help pages ask for the
hyphens, which detection removes, so there are no tracking links.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
