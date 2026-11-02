# DPD Belgium

DPD Belgium is DPD's network in Belgium. Its tracking page on dpd.com hands the number to
myDPD, DPD's consumer site, which also serves [DPD Switzerland](../dpd/README.md). Tracked
through the myDPD guest service with Belgium's business unit.

## How it works

1. `direct`: the guest API of the myDPD Android app, with `businessUnit=DPD-BE` and no
   postcode. The Firebase installation, Remote Config and OAuth token come first, as for
   [DPD Switzerland](../dpd/README.md#how-it-works), and are cached per instance.

- The reply must name the requested parcel and list dated milestones. A details 404, or a 400
  typed `PARCEL_NOT_FOUND`, is not found; another 400 or a reply without milestones is
  inconclusive, and malformed milestones are a schema error.
- Cloudflare's challenge page, whatever its HTTP status, is a challenge, and HTTP 429 a rate
  limit. No tier follows: the Swiss consignee page is not read.
- Recognition makes the same request and knows a number only when the reply's
  `shipmentBUCode` names DPD Belux, `034`, as the business unit that sent the parcel. Another
  unit's code is unknown, and a reply without one, or with `000`, is inconclusive.

## Notes

- The guest service is group-wide: every business unit answers for any DPD network's parcel
  with the same history, and the unit changes only the zone named for the current status. A
  matching number does not make a parcel Belgian, nor does a current country of Belgium: a
  parcel sent from abroad is placed there on its way to a Belgian recipient. Recognition reads
  who sent it instead. DPD Belux's GeoData guide puts `034` before every Belgian customer's
  depot, where DPD's GeoRouting specification puts the business unit. A parcel filed under DPD
  Belgium is read wherever DPD places it.
- A parcel DPD places in another country at its delivery depot or later names that country's
  unit as its `delivery_carrier`, under the same number, when the unit has a source of its own:
  [DPD Switzerland](../dpd/README.md), [DPD Germany](../dpd-de/README.md) and the units DPD
  Germany's [`abroad` step](../dpd-de/README.md#how-it-works) asks. The unit reads it with its
  own scans and places, which this lookup cannot. Before the delivery depot, the current country
  can be the sender's.
- Without a postcode DPD gives each milestone once, with its newest date and DPD's offset but
  no place. Earlier rounds of a milestone and the scans between are missing, so the answer is
  marked `history_truncated` for enabled providers to complete. The milestones can come out of
  order and are sorted newest first.
- The catalog asks for no postcode: the guest lookup answers without one.
- A clock DPD names no zone for is read in Belgian time.
- [DPD's map](../dpd/status.ts) stages the codes, and the codes it leaves unmapped stay so
  ([status.ts](status.ts)).

## Limitations

- The reply has no places, sender, weight or pickup point, and gives the delivery day without
  a window.
- The guest service drops older parcels and then answers as for an unknown number.

## Numbers

DPD Belgium parcels carry DPD's fourteen-digit parcel number, which every DPD network shares.
DPD Belux's label specification calls the first four digits a range code naming the sending
entity, and its values are not published. Belgian parcels start with different ranges, and
GeoRouting numbers depots within each business unit, so another unit's parcels can start with
the same digits. The number only suggests DPD Belgium, like the other DPD networks, and
recognition asks it. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

DPD Belgium's tracking page opens one parcel at
`www.dpdgroup.com/be/mydpd/my-parcels/track` with the number in `?parcelNumber=`, and results
link there. Such links, and others on the group site under `/be/`, name DPD Belgium.

## Testing

```sh
DPD_BE_TRACKING_NUMBER=... DPD_BE_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/dpd-be
```

Fixtures are synthetic ([fixtures/README.md](fixtures/README.md)).
