# Pullman Cargo

Pullman Cargo, also branded Pullman GO, carries parcels and cargo between its agencies and
distribution centres across Chile, for collection there or delivery to the door. Tracked
through the data its tracking page loads.

## How it works

1. `direct`: one `GET https://pullmancargo.cl/seguimiento/{odt}/__data.json?x-sveltekit-invalidated=01`,
   the request the SvelteKit tracking page makes when its form opens an ODT's page. It needs no
   cookie, token, key or browser. The reply is devalue's flat JSON list, where objects and
   arrays name their members by index. Its root holds the ODT asked and `seguimiento`, the
   ODT's scans newest first.
2. `retry`: the same read once more when Pullman Cargo cannot be reached.

- An unknown ODT gets HTTP 200 with an empty `seguimiento`, which the page reports as "ODT no
  encontrada". A 404 or a redirect is a moved route.
- The tracker matches the whole ODT as typed, leading zeroes included. The reply must echo the
  ODT asked, and every scan must name it.
- Recognition makes the same request. No detection rule offers it a number.

## Notes

- A scan's `fecha` is an instant in UTC, written the way Java prints a zoned time
  (`…Z[UTC]`). Archived replies of the former tracker give the same scans as Chilean wall
  clocks three hours behind in summer and four in winter. The adapter keeps it to the second.
- Each scan has only its web wording (`estadoWeb`), such as `Encomienda recibida en agencia de
  destino`, and the agency or distribution centre as its location. The map stages the wordings
  the tracker shows.
- Every scan repeats the shipment's origin and destination towns, whether it goes to the door
  or to an agency, its piece count and the step of the page's progress rail. None of them is
  kept.

## Limitations

- No estimate, weight, service or proof of delivery.
- The tracker lists milestones: the sorting and dispatch scans the former tracker showed are
  left out. No scan says that a parcel is ready to collect at its agency.

## Numbers

Pullman Cargo tracks a shipment by its eleven-digit transport order number (ODT), which the
tracking page asks for. Detection does not offer it, since eleven digits are shared with many
carriers' numeric waybills. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker at `pullmancargo.cl/seguimiento` opens an order at `/seguimiento/` followed by the
ODT, as the site's own form builds it.

## Testing

`npm run test:carriers:live -- carriers/pullman-cargo`, with `PULLMAN_CARGO_TRACKING_NUMBER` and
optionally `PULLMAN_CARGO_UNKNOWN_NUMBER` set outside the repository.
