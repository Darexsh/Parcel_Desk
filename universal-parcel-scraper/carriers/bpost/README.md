# bpost

Tracks parcel barcodes through the anonymous batch service used by bpost's
official frontend.

## How it works

One POST requests one barcode and returns minimized history
without a postcode. The single-item GET requires a postcode and can return a
missing-item error for a parcel the batch service knows.

## Notes

The returned item and search barcode must both match. Order references and
ambiguous results need an exact parcel barcode. Status comes from the newest
scan's English wording; pickup availability remains distinct from delivery.
Delivery to the sender is a return milestone; an ambiguous return delivery is
inconclusive. The same cheap lookup lets carrier recognition resolve ambiguous
numeric barcodes; only the batch service's explicit absence reply is negative.
The [documented parcel prefixes](https://www.bpost.be/en/faq/what-does-barcode-look-and-where-can-i-find-it)
prioritize recognition while retaining numeric ambiguity. bpost documents its
eighteen- and twenty-four-digit barcodes only with those prefixes, so
recognition asks bpost about no other run of digits, and those stay a
suggestion.
bpost does not name a `U` barcode ending in `BE`: bpost issues those only to
clear customs and does not track them.
bpost's licence plate, `JJBE`, a letter and eighteen digits, as on a
registered letter, selects bpost: every JJBE plate found so far, in bpost
tracking lookups archived by the Wayback Machine, was answered by bpost's
tracker, and no other carrier is known to issue the prefix. The longer plate
bpost's barcode page lists among its common parcel barcodes, the letter and
twenty-two digits, selects bpost too.

Scans on the way to a locker and at it name the locker `{{bboxRebrand}}`.
bpost's tracker puts there the name of the item's `bboxRebrandCategory` from
its translations, such as "bbox locker", and so does the adapter, in English.
An item available at the locker is ready for pickup.

The receiver's country code becomes `destination_country`. The sender's
barcode becomes `international_tracking_number` only when it is a valid S10
number other than the one searched, as on a parcel posted abroad.

Mail from abroad reaches bpost when a caller names it, a provider names it, or
a result gives Belgium as the destination of an S10 item. bpost answers under
the sending post's number, with the sender's side, customs at its international
depot and its own scans up to the delivery. A link on bpost.be, or to the
`etr/light` search on track.bpost.cloud with the number as `itemCodes`, names
bpost. Other pages of track.bpost.cloud name no one: Landmark Global's portal
there tracks the parcels of every postal partner.

The reply's `deliveryPoint` is the pickup point or locker itself, apart from
the receiver: bpost's tracker shows it with opening hours and directions from
its own coordinates. While the parcel waits there, and once it is delivered
with bpost's active step saying it was picked up there (`PICKED_UP_IN_…`, which
the tracker shows as "Collected"), `pickup_point` is the point's name, then its
street and number, then postcode and town, in one language. It is the name
alone when the street or town is missing. A parcel delivered to the door has
none.

## Limitations

Scan clocks have no offsets. bpost's scans in Belgium are on Belgian time: the
reply also gives the item's creation as an instant (`key.tmmCreated`), and that
is the pre-advice scan's clock read on Brussels time (`key.created` has the same
digits as UTC). So a scan that names Belgium, and every scan of a national
parcel (departure country and receiver both Belgium) even where it names no
country, is read on Brussels time. So is a scan that names no place at all or a
country alone, and, on a parcel sent abroad, a scan in the destination country
that does not name the partner's office: these are bpost's own records of the
partner's steps. On a parcel delivered in Portugal they matched CTT's instants on
Brussels time, while the partner's scans relayed under its office, such as
`PTLISL Portugal PT`, kept Lisbon's wall clock. Other scans keep their local digits, as
does a clock the change to summer time skips, and the provider's order is kept;
see [ROUTING.md](https://github.com/plhery/delivery-tracker/blob/main/docs/ROUTING.md) for unresolved
history handling. Weight and dimensions have explicit units. Recipient and
sender names and addresses, the point's code, delivery instructions and proof
assets are excluded. The delivery time bpost lists for a delivered parcel has no
offset either, and bpost's own page prints it as it comes. For a receiver in
Belgium it is read on Brussels time as `delivered_at`; for one abroad it stays
empty.

## Testing

Run `npm run test:carriers:live -- carriers/bpost`.
Set `BPOST_TRACKING_NUMBER` outside the repository to check a real parcel.
