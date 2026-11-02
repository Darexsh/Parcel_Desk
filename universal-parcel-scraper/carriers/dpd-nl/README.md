# DPD Netherlands

DPD Netherlands is DPD's network in the Netherlands. Its tracking page on dpd.com hands the
number to myDPD, DPD's consumer site, which also serves [DPD Switzerland](../dpd/README.md)
and [DPD Belgium](../dpd-be/README.md). Tracked through the myDPD guest service with the
Netherlands' business unit.

## How it works

1. `direct`: the guest API of the myDPD Android app, with `businessUnit=DPD-NL` and no
   postcode. The Firebase installation, Remote Config and OAuth token come first, as for
   [DPD Switzerland](../dpd/README.md#how-it-works), and are cached per instance.

- The reply must name the requested parcel and list dated milestones. A details 404, or a 400
  typed `PARCEL_NOT_FOUND`, is not found; another 400 or a reply without milestones is
  inconclusive, and malformed milestones are a schema error.
- Cloudflare's challenge page, whatever its HTTP status, is a challenge, and HTTP 429 a rate
  limit. No tier follows: the Swiss consignee page is not read.
- Recognition makes the same request and knows a number only when DPD's current country for
  the parcel is the Netherlands. Another country is unknown, and a reply without one is
  inconclusive.

## Notes

- The guest service is group-wide, as [DPD Belgium's notes](../dpd-be/README.md#notes)
  describe, so a matching number does not make a parcel Dutch: recognition needs the Dutch
  current country. A parcel filed under DPD Netherlands is read wherever DPD places it, and
  from the delivery depot on, one it places in another country names that country's unit as
  its `delivery_carrier`, as [DPD Belgium's notes](../dpd-be/README.md#notes) describe.
- DPD's current country can change as the parcel travels, from Belgium to the Netherlands
  for instance, and recognition then names the network the parcel has reached.
- Without a postcode DPD gives each milestone once, with its newest date and DPD's offset but
  no place, so the answer is marked `history_truncated` for enabled providers to complete.
  The milestones can come out of order and are sorted newest first.
- The catalog asks for no postcode: the guest lookup answers without one.
- A clock DPD names no zone for is read in Dutch time.
- [DPD's map](../dpd/status.ts) stages the codes, and the codes it leaves unmapped stay so
  ([status.ts](status.ts)).

## Limitations

- The reply has no places, sender, weight or pickup point, and gives the delivery day without
  a window.
- The guest service drops older parcels and then answers as for an unknown number.

## Numbers

DPD Netherlands parcels carry DPD's fourteen-digit parcel number, which every DPD network
shares, and a parcel keeps the range of the network that sent it. The number only suggests
DPD Netherlands, like the other DPD networks, and recognition asks it. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

DPD Netherlands' tracking page opens one parcel at
`www.dpdgroup.com/nl/mydpd/my-parcels/search` with the number in `?parcelNumber=`, and results
link there. Such links, and others on the group site under `/nl/`, name DPD Netherlands.

## Testing

```sh
DPD_NL_TRACKING_NUMBER=... DPD_NL_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/dpd-nl
```

Fixtures are synthetic ([fixtures/README.md](fixtures/README.md)).
