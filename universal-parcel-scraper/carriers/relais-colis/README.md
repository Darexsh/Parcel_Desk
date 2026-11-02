# Relais Colis

Tracks French pickup-point parcels through the public recipient form.

## Retrieval

Each lookup opens the form in its own cookie session, then posts its CSRF token
and the requested number. A reply with history has no search form and names the
parcel once, in its "Votre colis" banner. Each stage can contain several scan
boxes; every box becomes an event in the displayed order.

A reply without history re-renders the form with the searched number beside an
explicit no-history message; only that message proves absence. Redirects,
endpoint errors and invalid sessions remain inconclusive. Both requests share
one lookup budget and caller cancellation.

The number shown must equal the requested one after normalization. Pages with a
second or unlabelled banner or a conflicting form value are rejected, and so is
history without a banner: the form value only echoes the request.

Numeric references remain detection candidates because other carriers share
their shapes. Detection offers Relais Colis for ten digits only: an old customer
report is the only public fourteen-digit reference, and fourteen digits are
DPD's parcel number. Its help gives parcel numbers of 12 to 16 characters, and the
ten-digit ones come from older reports, so recognition asks Relais Colis only about
12 to 16 characters. The adapter submits the complete normalized reference and never
shortens it to make a returned parcel match.

The [official tracking help](https://aide.relaiscolis.com/hc/fr/articles/12437714695837-Comment-suivre-mon-colis)
describes complete references. Alphanumeric references that overlap Colis Privé
keep their ambiguity until the recipient form confirms a matching history.

## Normalization

Scan sentences supply the status. Paris wall clocks become timestamps; date-only
or invalid clocks remain unresolved history. Unfamiliar wording gets no stage
from the map, so the shared wording classifier reads it, and current wording
cannot borrow an older delivery state. Planned or ongoing returns are not
terminal. Address and recipient containers are discarded before extracting
scan fields.

## Limitations

The adapter returns history without pickup-point details or a delivery estimate.

## Live test

Supply `RELAIS_COLIS_TRACKING_NUMBER` and optionally `RELAIS_COLIS_UNKNOWN_NUMBER`
outside the repository, then run:

```sh
npm run test:carriers:live -- carriers/relais-colis/adapter.live.test.ts
```
