# DPD Hungary

DPD Hungary is DPD's network in Hungary. Its tracking box on dpd.com hands the number to myDPD,
DPD's consumer site, which also serves [DPD Switzerland](../dpd/README.md),
[DPD Belgium](../dpd-be/README.md) and [DPD Netherlands](../dpd-nl/README.md). Tracked through
the myDPD guest service with Hungary's business unit.

## How it works

1. `direct`: the guest API of the myDPD Android app, with `businessUnit=DPD-HU` and no
   postcode. The Firebase installation, Remote Config and OAuth token come first, as for
   [DPD Switzerland](../dpd/README.md#how-it-works), and are cached per instance.

- The reply must name the requested parcel and list dated milestones. A details 404, or a 400
  typed `PARCEL_NOT_FOUND`, is not found; another 400 or a reply without milestones is
  inconclusive, and malformed milestones are a schema error.
- Cloudflare's challenge page, whatever its HTTP status, is a challenge, and HTTP 429 a rate
  limit. No tier follows: the Swiss consignee page is not read.
- Recognition makes the same request and knows a number only when DPD's current country for
  the parcel is Hungary. Another country is unknown, and a reply without one is inconclusive.

## Notes

- The guest service is group-wide, as [DPD Belgium's notes](../dpd-be/README.md#notes)
  describe, so a matching number does not make a parcel Hungarian: recognition needs the
  Hungarian current country. A parcel filed under DPD Hungary is read wherever DPD places it,
  and from the delivery depot on, one it places in another country names that country's unit
  as its `delivery_carrier`, as [DPD Belgium's notes](../dpd-be/README.md#notes) describe.
- DPD Belgium reads who sent a parcel, from the business unit code in the reply. No public
  source gives DPD Hungary's code, so recognition reads the current country, as DPD
  Netherlands' does, and names DPD Hungary once a parcel from abroad reaches Hungary.
- DPD Belgium and DPD Netherlands name no delivery carrier for a parcel they place in Hungary:
  DPD Hungary reads the same guest reply, with nothing of its own to add.
- A parcel DPD Hungary hands to a Foxpost locker keeps DPD's number here. Foxpost tracks it
  under its own `CLFOX` number ([Foxpost's FAQ](https://foxpost.hu/gyik/)), which
  [Foxpost](../foxpost/README.md) reads.
- Without a postcode DPD gives each milestone once, with its newest date and DPD's offset but
  no place, so the answer is marked `history_truncated` for enabled providers to complete.
  The milestones can come out of order and are sorted newest first.
- The catalog asks for no postcode: the guest lookup answers without one.
- A clock DPD names no zone for is read in Hungarian time.
- [DPD's map](../dpd/status.ts) stages the codes, and the codes it leaves unmapped stay so
  ([status.ts](status.ts)).

## Limitations

- The reply has no places, sender, weight or pickup point, and gives the delivery day without
  a window.
- The guest service drops older parcels and then answers as for an unknown number.

## Numbers

DPD Hungary parcels carry DPD's fourteen-digit parcel number, which every DPD network shares,
and a parcel keeps the range of the network that sent it. The number only suggests DPD
Hungary, like the other DPD networks, and recognition asks it. [`numbers.json`](numbers.json)
says why it holds no sample yet.

## Links

DPD Hungary's tracking box opens one parcel at `www.dpdgroup.com/hu/mydpd/my-parcels/search`
with the number in `?parcelNumber=`, and results link there. Such links, and others on the
group site under `/hu/`, name DPD Hungary.

## Testing

```sh
DPD_HU_TRACKING_NUMBER=... DPD_HU_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/dpd-hu
```

Fixtures are synthetic ([fixtures/README.md](fixtures/README.md)).
