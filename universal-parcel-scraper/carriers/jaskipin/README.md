# Jaskipin Express

Jaskipin Express parcels use enabled universal providers. There is no dedicated adapter.

Jaskipin Express is a Cirebon shipping consolidator sending individuals' and online shops' parcels
from Indonesia abroad, handing them to DHL, FedEx, Aramex or Citylink for the international leg.
Its site is jaskipin.co.id.

## Numbers

No public page shows a Jaskipin order number, so there is no rule.

## Why there is no adapter

The tracking page asks an open JSON service without a session or CAPTCHA, but it answers an
unknown number with a server error, and no public number is known to see a found reply. Its reply
carries names and addresses, which an adapter would have to leave out.

## Links

The tracking page keeps the number out of its address, so no address opens one parcel.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
