# GLS Austria

GLS Austria is the GLS group's network in Austria. Its tracking page runs the group's tracking
widget against the same recipient service as GLS Germany's, Switzerland's and Poland's, so it
has no adapter of its own: `tracking.adapter` is [`gls-de`](../gls-de/README.md), whose folder
and [gls-ch](../gls-ch/README.md)'s explain the requests, identity checks and status handling.

## How it works

1. `direct`, through gls-de: the anonymous `rstt029` overview, then `rstt028` with the parcel
   number and the delivery postcode, under `https://gls-group.eu/app/service/open/rest/GROUP/en`.
   The overview must name the whole number before the postcode is sent.

- The Austrian page asks the same service under `/AT/de/` or `/AT/en/` rather than
  `/GROUP/en/`. The path sets only the language: both answer the same parcel with the same
  progress codes, event codes and delivery time, and an unknown number with the same
  `E000`. The group path is enough, and keeps one request builder for every network that
  uses it.
- The Austrian service is not limited to Austrian parcels. It shows parcels GLS Austria takes
  in and delivers, Austrian parcels delivered in Germany and parcels from other GLS networks
  delivered in Austria, and the group path shows the same ones. Whichever network handled it,
  the reply is bound to the requested number, or to its first eleven digits when the number
  was typed with its check digit.
- Like the group's other pages, the Austrian page shows the progress bar to anyone and the
  scans only after the delivery postcode. The postcode is optional in the catalog, so a parcel
  saved without it is tracked through enabled universal providers instead; the adapter then
  asks GLS nothing.
- An expired number is GLS's `E000` on the overview and an unknown one `E206`; both are not
  found. A postcode that does not match is `E609` or `E800` on the detail, which asks for the
  postcode again (`postcode_mismatch`).

## Notes

- The postcode is the recipient's, in any country's format, since an Austrian parcel can be
  delivered in Germany or elsewhere in GLS's network. GLS refuses a malformed one, such as a
  single digit, with HTTP 400.
- The service gives each scan's date and time without an offset, and the shared GLS parser
  reads them in Central European time, which Austria keeps. Results carry gls-de's
  `Europe/Berlin` label, so only the label differs from this carrier's zone.
- The scans' wording is the English of the GROUP path, which the shared GLS map reads.
  `statuses.json` also keeps the Austrian page's German wording of the same steps.
- Recognition asks the same overview, which names no owner, so it cannot tell an Austrian
  parcel from a German or Swiss one. The network is asked about eleven digits only for a caller
  in Austria: its rank sits below the other carriers that take the layout, and the caller's
  country then settles between the GLS networks that know the number.

## Limitations

- No scans without the delivery postcode.
- The service keeps a parcel for a few months, after which it answers `E000`.

## Numbers

Parcels carry the GLS group's eleven-digit parcel number, printed on labels with a twelfth
check digit, and an eight-character Track ID. Every GLS network issues the same layouts, and
their first digits name no network. Low rules offer GLS Austria for eleven digits and for the
twelve-digit form whose GLS check digit passes, beside the GLS Germany, Switzerland and France
entries. Recognition asks GLS Austria only for a caller in Austria (`servedCountriesOnly`), so
callers elsewhere are asked the same carriers as before. The Track ID has no rule here.

## Links

The tracking page `gls-group.com/AT/de/paket-verfolgen/` reads the number from `match`, so
`?match={number}` opens one parcel; the English page under `/AT/en/parcel-tracking/` does the
same. Links on `gls-group.com` or `gls-group.eu` under `/AT/` are read for GLS Austria.

## Testing

`npm run test:carriers:live -- carriers/gls-at`, with `GLS_AT_TRACKING_NUMBER` and optionally
`GLS_AT_POSTCODE`, its delivery postcode, and `GLS_AT_UNKNOWN_NUMBER` set outside the
repository.
