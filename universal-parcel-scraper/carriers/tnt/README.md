# TNT

Direct tracking covers 9-digit international consignments through the JSON read
behind tnt.com's public tracking page, and TNT France's 16-digit national
consignments through its public HTML tracking page.

TNT Australia's domestic consignments, three letters and nine digits, are not offered for TNT:
tnt.com's API refuses them as invalid input and sends the lookup to TNT Australia's own tracker,
which [TNT Australia](../tnt-au/README.md) reads.

## How it works

`direct` makes one GET, chosen by the number's shape. No session, browser,
postcode or account is required.

- 9 digits: `https://www.tnt.com/api/v3/shipment?con={number}&searchType=CON&locale=en_GB&channel=OPENTRACK`.
  A `notFound` entry for the number is a clean not-found, which recognition uses.
- 8 digits: the same request for the serial and its Mod 11 check digit, which is what
  tnt.com looks up when given the serial alone. The 9 digits become the canonical number.
- `GE`, 9 digits and `WW`: the same request for the 9 digits. ExpressConnect's guide and
  tnt.it's tracking guide print consignments this way, with or without the letters.
- 16 digits: the national consignment detail page on tnt.fr. tnt.com rejects these
  numbers, so they are never sent there.

## Notes

- Local detection accepts both consignment checks in
  [ExpressConnect's Appendix I](https://express.tnt.com/expresswebservices-website/docs/ExpressConnect%20Shipping%20Integration%20Guide%20v3.7.pdf).
  A passing check prioritizes a candidate without confirming a shipment. The
  international checks do not apply to French national references.
- Detection names TNT for `GE`, 9 digits and `WW` when the 9 digits pass the modulus 11
  check. `WW` is no country, so no post issues the code. A country code in place of `WW`,
  as ExpressConnect's examples also print, stays with the generic postal carrier: posts
  issue `G` series codes too.
- TNT's help pages speak of 8- or 9-digit numbers: the serial with or without its check digit.
  Eight digits have no check to filter on and tnt.com lists a consignment for almost any
  serial, so detection has no 8-digit rule and recognition never asks for one; only a reader's
  or provider's choice of TNT tracks it.
- A tnt.com tracking link, or the `/track` link the page shares, names TNT for the
  consignment in its `cons` parameter, an 8-digit serial included: the reader chose TNT, and
  the adapter completes the serial as tnt.com does. A link searching by reference
  (`searchType=REF`) holds the sender's reference, so its number is left to detection. The
  Spanish, French and Swiss Italian sites give the tracking page its own path.
- tnt.com lists every consignment that carried the number, since numbers are reused.
  Only consignments whose own number matches are read, and the one with the most recent
  scan is the parcel. References, signatories and addresses are not kept, except the
  destination's country: its `countryCode`, or else its name, becomes
  `destination_country` (or `destination_country_name` for a name without an ISO code).
- tnt.com scan times carry offsets. Scan codes (`legacyCode`) set the stage, because the
  wording is prose: "partially delivered" is not a delivery, and a residential delivery
  (`RES`) reads like `OK`. The estimate is kept as a calendar day until delivery.
  Customs release returns to transit even when the wording still mentions customs.
- tnt.com enters some transit scans at their planned time, before they happen. A scan dated
  more than five minutes after the lookup is held back until it is due (`plannedScans`).
- A shipment either site lists without scans is a `NoHistoryError`: TNT knows the label
  but has not scanned it yet, which is an answer about the parcel, not an outage.
- On tnt.fr, the returned detail header and item identity must match. History comes only
  from the shipment's event rows; the progress rail includes future delivery labels.
  The selected milestone determines current status. National scan times are read in the
  French civil timezone, and the page's Latin-1 encoding is respected.

## Limitations

The link opens tnt.com, which cannot show TNT France consignments. Public histories can
expire.

## Testing

Set `TNT_TRACKING_NUMBER` (9 digits) or `TNT_FRANCE_TRACKING_NUMBER` (16 digits) outside
the repository, then run `npm run test:carriers:live -- carriers/tnt`.
The wrong-number check runs without either.
