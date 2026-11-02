# Fixtures

Each fixture follows the reply of the lookup APC's tracker page makes for one number,
`GET tracking.apc-pli.com/api/track?id={number}`: the parcel, its references and its scans,
newest first, each with a code, APC's wording, a place and a clock labelled `+00:00`.

- `delivered.json` is a parcel handed to a delivery partner, which names it by the partner's
  number. It carries APC's facility scans, flights, customs, a handoff notice, a scan listed twice,
  places holding a street or the recipient's address, a merchant's reference and the partner's
  free text.
- `in-transit.json` is a parcel before the handoff, with a partner scan carrying its own offset,
  an attempt and a status the map does not know.
- `not-found.json` is the answer, with HTTP 500, for a number the lookup has nothing to show for.

Numbers, references, addresses, places, people, links and clocks are invented.
