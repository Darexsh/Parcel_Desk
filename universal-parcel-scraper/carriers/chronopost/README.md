# Chronopost

Chronopost France, including Chrono Shop2Shop and partner scans after export.

## Retrieval

One direct HTTP POST calls `trackSkybillV2` on the
[official tracking service](https://ws.chronopost.fr/tracking-cxf/TrackingServiceWS?wsdl).
The operation requires only the language and whole tracking number, with no
account credentials or browser. The returned `skybillNumber` must match.
An identity-bound, successful empty event list is not-found; service errors,
SOAP faults, blocked pages and malformed replies stay failures. A request that
fails to reach the service, or hangs, is sent once more as the `retry` step:
the first gets half of the budget, so the second fits in the rest.

The service includes international scans and the partner reference that
[La Poste's unified feed](../la-poste/README.md) can omit. That feed has no
reliable completeness flag, so it does not substitute for Chronopost history.
The public page's `tracking-no-cms/suivi-colis` fragment and Shop2Shop's
`tracking-ws-rest` endpoint can require a browser challenge.

## Routing and interpretation

Dedicated postal prefixes select Chronopost when their S10 check digit passes
and only suggest it when it fails. Their suffix can be a code of Chronopost's own, such as TS, JF, JB, RV or VF,
rather than a country, so these numbers are not international mail. The
common TS, JF and JB suffixes also select Chronopost after any other
two-letter prefix, with or without an S10 check digit: such numbers often
carry none, and no other carrier issues them. RV and VF have rarely been seen
outside the dedicated prefixes, so there they only suggest Chronopost, with or
without a check digit. Other posts' codes suggest Chronopost only when their
S10 check digit passes: a failed one is a mistyped number, which Chronopost's
hubs never scanned. A fifteen-character numeric identifier
must pass the shared DPD check-character validation. The fourteen digits
without their check character, as DPD's notices print them, suggest Chronopost
too, beside the DPD network's other carriers: Chronopost answers either form
for a DPD parcel it delivers in France, and only the parcel's destination tells
the carriers apart. Numbers from DPD France's own depots, starting 10, stay DPD
France's. These shapes suggest a lookup, not carrier ownership.
XN and twelve digits suggest Chronopost alone: its tracker answers that shape,
which no public source documents.

Chronopost also answers for other posts' letter and parcel items that pass
through one of its hubs, often with that single scan. La Poste delivers those
in France and its overseas departments and holds their whole history, so such
an item names La Poste as its delivery carrier. EMS items, French items and
Chronopost's own codes do not: Chronopost delivers inbound EMS itself. Nor is
the destination's post proposed for them, though their shape passes the S10
check: La Poste's feed relays Chronopost's scans and would take the parcel over.

A scan's location is its office, or the depot Chronopost names for a partner's
scan abroad. Office labels that name a service rather than a place give none:
"Web Services" on the shipper's preparation, "Service d'avisage" on
notifications and "CHRONOPOST NETWORKS" abroad. The app's scan-identity policy
lets a scan stored with one of them keep its row once it loses it, provided its
instant, wording and known stage agree. Earlier releases read Chronopost's scans
from La Poste's feed, to the minute, under La Poste's codes and without an
office. A scan in the same words less than a minute from such a row takes it
over, whatever stage either map read, unless another scan of the history could
claim it.

Scans retain their supplied offsets and seconds, except at a partner's depot in a
country on another clock than Paris: Chronopost gives such a scan the depot's wall
clock under Paris's offset, the wall clock the partner's own feed shows. It keeps
that wall clock alone, and its town dates it. Offset-less clocks stay
local. Notifications and the recipient's delivery instructions retain activity
without changing the last established shipment stage, and neither does a
courier's drop-off scan that follows the pickup point's arrival scan. Before the parcel
has moved, a pickup point's scan of it at another point than the one planned is the
sender's drop-off there, which the point hands to the courier next: it accepts the
parcel, which does not wait for the recipient. The point's hand-over to the courier
(TT) is part of that acceptance too, a minute before the courier's take-over (PC). Observed
codes are used only when their wording agrees, because partner scans can reuse
codes; a code can carry several wordings, each read on its own. Chronopost can write
a scan twice, such as the arrival at a pickup point under two of its codes or a depot's
sort under one: in the same words at the same place, less than two minutes apart, it is
shown once.

Once a scan sends the parcel back to the sender, it is an exception with no
delivery estimate. The return's own scans keep their stages, and a delivery
after that reaches the sender, so it is `returned`.

A delivery instruction can carry the redelivery day the recipient chose, and
scans can carry the booked appointment window. The newest scan with either
becomes the expected delivery, a redelivery day replacing a window on the same
scan; an unreadable value gives none. It lapses once a later scan is not
progress towards that delivery or falls on a later day.

While the parcel waits at a relay or locker, that becomes the pickup point: its
name, then its street and town on their own lines when its address has the
usual name, street, postcode, city and country layout. A scan names it as the
pickup point, or as the delivery point together with how the parcel is
collected; a delivery point alone can be the recipient's home. A delivered
parcel has none, collected there or not.

A checked `GEO/` parcel reference with an explicit German or Portuguese delivery
country proposes DPD Germany or DPD Portugal: Chronopost's European service runs
on the DPD network, which delivers there under its own name. The tracker asks
that adapter with the partner's number and returns its independent confirmation
for consumer routing. Other safe partner references remain available for
catalog-based confirmation. A reference
that repeats the skybill's own letters and digits, followed by a service code
and a check character, is Geopost's form of the same parcel and is dropped.
Conflicting references or countries do not select a partner. Master and child
identities remain separate.

## Limitations

The tracking operation supplies no delivery estimate beyond appointment
windows and chosen redelivery days. Recipient addresses, delivery-point contact
details and free-form supplementary comments are discarded; only the delivery
country's code and a pickup point's name and address are read from the address
fields.

## Testing

`npm run test:carriers:live -- carriers/chronopost` checks unknown-number handling.
Set `CHRONOPOST_TRACKING_NUMBER` outside Git to check positive retrieval and
HTTP recognition.
