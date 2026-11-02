# GLS Poland

GLS Poland is the GLS group's network in Poland. Its tracking page runs the group's tracking
widget against the same recipient service as GLS Germany's and GLS Switzerland's, so it has no
adapter of its own: `tracking.adapter` is [`gls-de`](../gls-de/README.md), whose folder and
[gls-ch](../gls-ch/README.md)'s explain the requests, identity checks and status handling.

## How it works

1. `direct`, through gls-de: the anonymous `rstt029` overview, then `rstt028` with the parcel
   number and the delivery postcode, under `https://gls-group.eu/app/service/open/rest/GROUP/en`.
   The overview must name the whole number before the postcode is sent.

- The Polish page asks the same service under `/PL/pl/` rather than `/GROUP/en/`. The path
  sets only the language: both answer the same parcels with the same codes and clocks.
- Like the group's other pages, the Polish page shows the progress bar to anyone and the
  scans only after the delivery postcode. The postcode is optional in the catalog, so a
  parcel saved without it is tracked through enabled universal providers instead; the
  adapter then asks GLS nothing.
- An expired number is GLS's `E000` on the overview and an unknown one `E206`; both are not
  found. A postcode that does not match is `E609` or `E800` on the detail, which asks for the
  postcode again (`postcode_mismatch`).

## Notes

- The postcode is sent as typed, as the Polish page sends it. GLS refuses a malformed one,
  such as a single digit, with HTTP 400, and takes a Polish postcode with its hyphen, a space
  or neither as well-formed.
- Results carry gls-de's `Europe/Berlin` label. Poland keeps the same clocks and every scan
  carries its offset, so only the label differs from this carrier's zone.
- The scans' wording is the English of the GROUP path, which the shared GLS map reads.
  `statuses.json` also keeps the Polish page's wording of the same steps.
- Recognition asks the same overview, which names no owner, so it cannot tell a Polish parcel
  from a German or Swiss one. The network is asked about eleven digits only for a caller in
  Poland: its rank sits below the other carriers that take the layout, and the caller's country
  then settles between the GLS networks that know the number.

## Limitations

- No scans without the delivery postcode.
- The service keeps a parcel for a few months, after which it answers `E000`.

## Numbers

Parcels carry the GLS group's eleven-digit parcel number, printed on labels with a twelfth
check digit. Archived replies of GLS Poland's tracking service show both forms. Every GLS
network issues the same layout, and its first digits name no network. Low rules offer GLS
Poland for eleven digits and for the twelve-digit form whose GLS check digit passes, beside the
GLS Germany, Switzerland and France entries. Recognition asks GLS Poland only for a caller in
Poland (`servedCountriesOnly`), so callers elsewhere are asked the same carriers as before, and
a Polish caller's parcel is filed here in either form rather than under GLS Germany, whose
tracker requires the postcode.

## Links

The tracking page `gls-group.com/PL/pl/sledzenie-paczek/` reads the number from `match`, so
`?match={number}` opens one parcel; the English page under `/PL/en/parcel-tracking/` does the
same. Links on `gls-group.com` or `gls-group.eu` under `/PL/` are read for GLS Poland.

## Testing

`npm run test:carriers:live -- carriers/gls-pl`, with `GLS_PL_TRACKING_NUMBER` and optionally
`GLS_PL_POSTCODE`, its delivery postcode, and `GLS_PL_UNKNOWN_NUMBER` set outside the
repository.
