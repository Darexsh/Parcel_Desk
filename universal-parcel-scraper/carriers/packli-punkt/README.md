# Päckli Punkt

Päckli Punkt parcels use enabled universal providers. There is no dedicated adapter.

Päckli Punkt is a network of drop-off and pickup points in Swiss kiosks and shops, run by
7Days Media Services. Shoppers return parcels to partner online shops there and get a receipt
with the parcel number; Päckli Punkt carries the returns to the shops itself and is liable
from drop-off. Selected shops also deliver orders to a point for pickup. Its French pages call
the service Relais Colis, which is not the French Relais Colis network.

## Numbers

The parcel number on the drop-off receipt is what the tracker takes, and its field accepts
digits only. No public source shows one, so the corpus is empty and no rule claims a shape.

## Links

`paeckli-punkt.ch/paket-verfolgen/` with `packet` opens one parcel; the French, Italian and
English tracking pages take the same parameter.

## Why there is no adapter

The tracking page answers a GET with server-rendered HTML, with no token or CAPTCHA. An unknown
number gets "Paket noch nicht abgegeben", the page's wording for a parcel not yet dropped off,
so that answer does not tell a missing number from a parcel still to be handed in. No public
source shows a parcel number, so a found reply has not been seen.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
