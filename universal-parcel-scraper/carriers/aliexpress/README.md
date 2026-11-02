# AliExpress / Cainiao

Cainiao is Alibaba's logistics network and carries the international leg of most AliExpress
orders. It rarely does the last mile: it hands the parcel to a local post or courier and
publishes that partner's number when it has one. The catalog recognizes Cainiao's `DOFR…HD` and
`CNFR…HD` shipment numbers and its `CNG` numbers with fourteen digits, which Cainiao's tracker
answers and no other carrier issues. It also recognizes the numbers
[Maersk eCommerce](../maersk-ecommerce/README.md) gives Cainiao's parcels in the United States,
`1MCAINIXX` and ten digits, which open with Maersk's code for Cainiao: Cainiao's tracker follows
them through Maersk's leg. It recognizes `AP` and fourteen digits as well: no other carrier prints
the layout, and every parcel seen with it was AliExpress's. Detection suggests AliExpress for
Cainiao's other references, such as `CNUSUP` and `LP` with fourteen or seventeen digits, and suggests it first for a
postal-format number ending in `TY`, `MI` or `XX`, suffixes that name no country and that Cainiao
gives AliExpress parcels. Detection does not select the last-mile carrier.

## Partner numbers

AliExpress often gives the buyer the delivery partner's number while the parcel is still on
Cainiao's leg. The partner does not know the parcel yet, so only Cainiao's tracker answers for that
number. Detection suggests AliExpress for the partner shapes with such a lookup on record, for
example SDA's thirteen-character waybills in Italy or GOFO's `GFUS` waybills in the United
States, and recognition asks Cainiao beside the partner. It also suggests AliExpress for `HRBC`
and ten digits, numbers universal providers file under YFH and Cainiao: Cainiao's tracker answered
one, YFH's did not know it and Ekart's knew neither. The rules are in [`carrier.json`](carrier.json)
and their evidence in [`numbers.json`](numbers.json).

Once the parcel has crossed the border both know the number. It is one journey, so recognition
files it under AliExpress, which holds the scans from before the border, instead of leaving the
choice to the user. The result then proposes the partner as a hand-off: the one carrier at home
in the destination country whose rule fits the number. A consumer adopts it when it reports the
parcel.

Cainiao's tracker also follows partner numbers in shapes no rule suggests it for: plain digits, or
a format another carrier's rule claims with high confidence. For those the user picks AliExpress
or pastes a `global.cainiao.com` link. A high-confidence format, such as Ecoscooting's `CNPRT`
references, names the hand-off partner when that carrier delivers in the destination country, so
a consumer can keep a parcel filed under it and show Cainiao's answer as the earlier leg.

## How it works

1. `direct`: one keyless GET to `https://global.cainiao.com/global/detail.json?mailNos={number}&lang=en-US`,
   the JSON behind the consumer page, with that page as its Referer: the feed refuses a request
   another site refers. No session, cookie or token. 10 s budget, no fallback tier.
   A `DOFR…HD` or `CNFR…HD` number that feed does not know is asked again, in the same budget, at
   `https://track.cainiao.com/coe/trace/queryDetail?mailNos={number}&lang=en-US&language=en-US`,
   Cainiao Express's own tracker behind `track.cainiao.com/orderTrack`. It answers the same module
   shape inside `data`.

HTTP recognition uses that same feed for ambiguous references. Matching shipment
activity confirms the Cainiao tracking leg; an empty internal pending module does not.

## Handoff

- The partner number comes from `copyRealMailNo`; only when that is missing or malformed is it
  extracted from the display prose in `realMailNo`. It is returned as `delivery_tracking_number`,
  with `destCountry` as `destination_country_name`. A reference equal to the queried number
  is omitted so it cannot create a handoff back to the same identifier, and so is one of
  Cainiao's own numbers, such as the `CNG` number it gives beside an Ecoscooting `CNPRT`
  reference: it names no partner, and would hide Ecoscooting's hand-off. Cainiao can follow the
  country with the recipient's town after a comma; only the part before the comma is read.
- The host decides whether to hand off to the partner; see [`docs/ROUTING.md`](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md).
  Checksum-valid `L…CH` numbers keep a Swiss Post confirmation probe unless Cainiao names another
  destination. The destination label only restricts that probe; it never picks the operator.

## Notes

- The endpoint can return several modules. Only the one whose `mailNo` equals the requested
  number is read; anything else is a `SchemaError`, because showing a stranger's parcel is worse
  than an error.
- The newest `latestTrace.actionCode` decides the status. The parcel-level `status` token
  (`DELIVERED`, `CLEAR_CUSTOMS`, `transport`…) has no stable vocabulary, so it is only a fallback
  when no action code exists, and an unknown token before any scan states no stage. The
  action-code map started from the MIT client [ha-cainiao](https://github.com/ha-parcel-integrations/ha-cainiao).
- `GTMS_STA_SIGNED` means a pickup station signed, not the recipient: it maps to
  `ready_for_pickup`, never `delivered`. A pickup point's own delivery scan, `GSTA_SIGN`, is the
  recipient collecting the parcel.
- `GTMS_DEL_FAILURE` is a missed delivery: the parcel is an `exception` at the `failed_attempt`
  stage, as Cainiao's last-mile gateway also reports it for [Ecoscooting](../ecoscooting/README.md).
- Each scan is staged by its own action code, so pickup availability stays distinct from the
  delivery round after collection. Customs entry and clearance start remain customs until release;
  collection by the origin carrier is acceptance. A partner accepting the parcel after the
  hand-off (`GTMS_ACCEPT`, `SL_ACCEPT`, `LH_POST_COLLECTION`) stays in transit.
- An empty module is not-found only when `mailNoSource` is `EXTERNAL`. Otherwise the seller has
  not shipped yet and the parcel stays pending at the `registered` stage; a 404 would make the sync
  give up on an early parcel. Neither that stage nor a seller token such as `SELLER_PREPARING`
  before any scan comes with a time, so a consumer that dates stages dates it when it first sees it.
- `DOFR…HD` and `CNFR…HD` are Cainiao Express's home-delivery numbers in France. Partners such as
  4PX hand their own parcels over under them, and AliExpress's feed does not hold those. Cainiao
  Express's tracker holds them from the moment it receives the parcel; before that only the partner
  knows the number. So a home-delivery number neither tracker knows is `indeterminate` with the
  reason `portal_not_found`, not not-found. Cainiao Express's history starts at its own hub, without
  the partner's leg.
- Scan time is `timeStr` (local wall clock) plus `timeZone` (`GMT+2`, `GMT+8`…). `timeStr` alone
  would be read as UTC, the catalog timezone. The epoch `time` field is not the instant: it treats
  `timeStr` as Beijing time even for European scans.
- Cainiao's own notices (`LAST_MILE_ASN_NOTIFY`) carry no `timeZone`. Their epoch
  keeps milliseconds that `timeStr` cannot hold, so the epoch is the recorded instant and `timeStr`
  its Beijing rendering: such a scan is read at `+08:00`. Any other scan without `timeZone` keeps its
  raw text, because a whole-second epoch may only be a reading of that text.
- The flight out of the departure country (`LH_HO_AIRLINE`, `LH_DEPART`) sometimes comes at
  exactly midnight, on a day that can precede export clearance. That is the flight's planned day,
  so it is kept as a date in `local_time`; a flight with any other time keeps it.
- Each event keeps its action code as `provider_code`. Unknown action codes leave the event without
  a stage; the sync classifies the wording and records it, with the code, for review. `statusMap`
  answers the review by code, and by wording for the four codes the queue held before events kept
  theirs.
- Cainiao's notices keep the stage of the scan before them, or pending before any: its advance
  notice to the courier that delivers the parcel ("Last-mile delivery forecast", sent after a scan
  and carrying no date), a changed order and a transit sorting center's failed inbound. When one
  is the newest row, the parcel's status is that of its newest scan with a moving stage, and the
  notice stays the last update.
- The global feed has no place field. It writes a scan's town in brackets before the standard
  wording, `[Town] Out for delivery`, in every language. That town becomes the location and the
  wording keeps the rest. A bracket holding other digits than a trailing postcode, capitals only,
  fewer than three letters or a carrier the module names stays in the text, unless it names a
  country. Explicit numbered arrondissements of Paris, Lyon and Marseille are accepted even in
  uppercase. Cainiao Express's tracker puts a town or a country code in `location`; the town rule
  reads it when the wording has no bracket. A bracket can name the country first,
  `[USA,Example City]` or `[ES,Town 00000]`: the location is then the town, with a trailing
  postcode, followed by that country, and a town in capitals counts when it has five letters or
  several words. A US town can come with its state and ZIP code, `[Town, CA 00000]`, and keeps
  them, as USPS writes its places. A bracket can also name a country alone, `[ES]` or `[Spain 00000]`, which puts
  the postcode first so the country stays last. A country code a state shares is written out
  ("Canada"). Otherwise the location is the town alone.
- In the United States a scan's offset follows its site, so the place lookup can tell
  same-named towns apart by it.
- Some steps, the transit sorting centers' scans and the last-mile notice among them, have the
  placeholder "Carrier update" as their standard wording. Their own wording (`desc`) is shown
  instead when they have one.
- The app scan-identity policy reconciles extracted towns, a placeholder's replacement and
  corrected milestones at the same instant. A replacement requires the same action code and place,
  whatever the stage, and stage corrections a matching action code, wording and place. The
  consumer requires unique matches to update the stored scan.

## Limitations

- Undocumented, keyless endpoint. Failures surface as sync errors; nothing retries them.
- After a burst of lookups Cainiao answers with Alibaba's slider page instead of the JSON. That
  page is reported as a `challenge`; the adapter does not solve it.
- Scans without a bracketed town have no location. Customs, line-haul and pickup-point scans carry
  none.
- No pickup point: the scans do not name it, and the consumer page leaves self-pickup details to a
  signed-in AliExpress account.
- At most 100 scans are kept so longer journeys retain their origin events. The recipient block and
  proof-of-delivery links are never read.

## Testing

`npm run test:carriers:live -- carriers/aliexpress` needs no env vars. It checks
not-found with a synthetic number, and handoff extraction on two public examples in `numbers.json`:
one keeps the partner's number, the other names no partner for a number of Cainiao's own.
`CAINIAO_TRACKING_NUMBER` adds a private shipment lookup through automatic detection, and
`CAINIAO_EXPRESS_TRACKING_NUMBER` a home-delivery number a partner handed to Cainiao Express.
