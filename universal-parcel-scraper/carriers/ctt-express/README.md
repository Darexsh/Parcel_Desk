# CTT Express

Tracks single-piece Spanish shipment references and complete package codes through the anonymous JSON route
used by the official public tracking app.

## How it works

One GET requests shipment history using the complete input. The returned shipment must match exactly and
its package code must identify the sole package according to the carrier's
[label specification](https://transfer.cttexpress.com/IT/export/integra/Shipment_Number_Calculation_and_Package_Codes_of_CttExpress.pdf).
Package inputs retain their counter and must match the returned package exactly.
Multi-piece shipments remain inconclusive because the public response contains
only one package's scans. Portuguese postal references use the universal providers.
A few percent of lookups get an error reply or a body that is not JSON, and the same parcel
reads normally on the next poll, so those are read once more, as is a request that fails to
reach the service. A number with no shipment gets HTTP 200 with an empty body, which the
tracking page reads as a shipment it has not located; two empty reads in a row are not found.
Every code in CTT Express's agency list starts with `00`, so detection claims a reference only when
both its agency codes do. TIPSA numbers share the agency, agency, waybill layout. A reference starting
`000010` stays ambiguous between the two and any other selects CTT Express.

## Notes

The feed provides ascending scans with explicit offsets. Histories are projected
newest first; unresolved newest clocks retain their place and local digits or
provider text. Pickup availability and returns in progress do not complete a
delivery. An explicit return start establishes the sender-bound leg across later
movement scans; completed delivery on that leg means returned. The outbound
estimate stays suppressed throughout the return. The portal's presentation rail
can fill in future milestones, so only actual scan rows are retained. Empty
histories, histories holding only customer service cases, token errors and
unbound error replies remain inconclusive. Calendar estimates retain their date-only precision
for active deliveries when they are no older than the latest dated scan. Pickup,
delivery, incidents and document holds suppress estimates. A rescheduled
delivery day replaces the committed one. The weight is the one measured in the
network, else the one the sender declared. A parcel that entered from another
postal network keeps that network's S10 number as its international number. CTT Portugal
tracks its own numbers, those ending in `PT`, so such a number also names CTT Portugal as the
delivery partner and the tracker asks it about the parcel. On such a parcel, the delivery steps
CTT Express relays from CTT Portugal (out for delivery, a failed attempt, the delivery and
availability at a pickup point) carry Lisbon's wall clock with Madrid's offset: CTT Portugal's
own rows of the same scans are an hour later to the second. Those steps are read on Lisbon's
clock. CTT Express's own scans before the hand-over keep the instant it gives.
Customer service cases are skipped: they are not scans and carry the
recipient's contact details. Other measurements, contact information and
free-form delivery comments are excluded.

## Testing

Set `CTT_EXPRESS_TRACKING_NUMBER` to an authorized real Spanish reference and run
`npm run test:carriers:live -- carriers/ctt-express`.
