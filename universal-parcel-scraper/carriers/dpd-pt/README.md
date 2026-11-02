# DPD Portugal

DPD Portugal is DPDgroup's network in Portugal, formed from Chronopost Portugal and SEUR
Portugal. It runs its own tracker on `tracking.dpd.pt`, apart from the `dpd.com` and
`dpdgroup.com` pages that the other `dpd-*` entries read. Tracked through that tracker's page.

## How it works

1. `direct`: one `GET https://tracking.dpd.pt/?reference={number}`, the address the page's
   search form sends the browser to; the older `/track-and-trace?reference=` address redirects
   there. It needs no cookie, token or browser. The server-rendered page in Portuguese names the
   reference asked and lists the parcel's scans, newest first, with a code, a day, a time, a
   wording, a comment and a map link.
2. `retry`: one more try when the request fails to reach DPD Portugal or hangs. The first try
   gets half of the budget.

- The page's heading must name the number asked, with or without a colon after its label.
- An unknown number gets the page's notice that it found no results for it, worded in English
  or in Portuguese: not found. A
  reference the page holds no scans for gets an empty table without that notice, which is no
  history. A 404 or a redirect says nothing about the parcel.
- A page without the tracker's heading is a bot check when it looks like one, otherwise a
  changed page.
- Recognition makes the same request. The tracker knows only parcels in DPD Portugal's network:
  current parcels of other DPD networks are unknown to it.
- DPD Portugal promotes the group's myDPD app, whose guest service in [dpd](../dpd/README.md)
  answers current DPD Portugal parcels with Portugal as the country, but only with a few
  milestones and nothing for older parcels. The page is read instead.

## Notes

- A number typed with the label's check character is looked up by its fourteen digits, as in
  [dpd](../dpd/README.md); a character that does not match is refused as a typo. The tracker
  itself answers a wrong character with its not-found notice.
- Times have no zone, and DPD Portugal also delivers on the Azores and lists hub scans abroad,
  so they stay wall clocks.
- The codes are mapped in [status.ts](status.ts). A courier's collection accepts the parcel
  unless an earlier scan already moved it, as at the pickup point where the sender dropped it.
  Once a return to the sender is ordered, the proof of delivery is the delivery back to the
  sender, so the parcel is returned. Messages to the recipient and requests for a new delivery
  or address keep the stage of the scan before them. The row giving the expected delivery day
  is left out: its day and time are when DPD set it, so as a step it would show a day the
  parcel was not due.
- The comment column mixes the receiver's name, delivery windows, depot numbers, country
  codes, pickup point codes and references. Only the name the pickup point's own scan gives
  is kept, as the pickup point of a parcel that waits there or was collected there.
- The map links give coordinates, which for a delivery or a failed attempt point at the
  recipient's address; they are not kept, and the scans have no place. The proof of delivery
  image is not read.

## Limitations

- No places, delivery estimate, weight, sender or service.
- Older parcels drop out of the tracker, which then gives its not-found notice for them.

## Numbers

Parcels carry DPD's fourteen-digit parcel number, which labels and shipping messages may follow
with a check character. Archived lookups on the tracker and complaints answered by DPD Portugal
show both forms. Every DPD network issues the same layout and the other DPD entries suggest it
with low rules. The first four digits are the sending depot: DPD's routing depot table gives
Portugal 0955 to 0979, and the tracker's archived lookups and Portuguese complaints add 0980
to 0988, which no other network uses. A preferred low rule puts DPD Portugal first for those
depots. Its tracker also answers parcels from other depots, which DPD Portugal delivers too, so
a plain low rule offers it for every DPD number. Its recognition rank is below the other DPD
networks', so for fourteen digits from another depot it is among the first carriers asked only
in a lookup from Portugal. DPD Poland's preferred rule still lists DPD Poland first for numbers starting with 13,
a range DPD Portugal issues too.

## Links

The tracker reads the number from `reference` on `tracking.dpd.pt/`, so
`?reference={number}` opens one parcel; `/track-and-trace?reference={number}` redirects there. DPD's Portuguese pages build the same address on
`dpd.pt`, which forwards to the tracker, and archived lookups also use the English page
`/en/getting-parcel/track-trace`.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Testing

`npm run test:carriers:live -- carriers/dpd-pt`, with `DPD_PT_TRACKING_NUMBER` and optionally
`DPD_PT_UNKNOWN_NUMBER` set outside the repository.
