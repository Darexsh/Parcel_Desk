# OnTrac

Tracks OnTrac and LaserShip parcels through the JSON endpoint used by the official website.
LaserShip merged into OnTrac, so a provider that names LaserShip names OnTrac.

## How it works

One anonymous GET returns packages and scans. Exactly one returned tracking identifier must
match the request. A generic missing-resource problem response cannot distinguish an
unknown parcel from an unavailable endpoint, so it remains inconclusive. An empty or
mismatched package list is inconclusive or a schema failure.

When the user picks OnTrac, or opens an OnTrac link carrying one, a shipper's `AD`
reference is sent too. The endpoint resolves it to the parcel without repeating it, so the
reply must hold one parcel with an OnTrac or LaserShip number, which becomes
`canonical_tracking_number`; several parcels stay inconclusive. Detection does not point
these references to OnTrac, since they are the shipper's.

The `C` and `D` number families are offered only when the last digit matches UPS's `1Z`
check, with C counted as 4 and D as 5. Numbers starting `C1` or `D10`, the ranges OnTrac's
own tracker shows, select OnTrac. Other senders print `C` numbers of the same length, and
about one in ten of any such numbers passes the check, so the rest stay suggestions. HTTP
recognition requires matching shipment scans; an unavailable tracking resource remains a
failed probe.

## Notes

The endpoint's newest-first order is preserved, including scans without offsets. Valid
offset-less clocks remain local wall times; invalid dates retain their text on an undated event. Incomplete
scan rows fail the lookup so older progress cannot appear current. Each
scan uses its own regional status code; unfamiliar codes keep their wording for review.
The parser reads short scan descriptions and city/state, the weight and the parcel's
sides in OnTrac's unit, excluding recipient details, references, signatures and
proof-of-delivery images. The hold code asking the recipient for address details or
instructions is an exception; a delivery stopped for missing address details is a failed
attempt. NFRP, an order transferred to another carrier, is in transit although OnTrac's page
calls it delivered: the reply does not name the carrier that delivers it.

## Testing

`npm run test:carriers:live -- carriers/ontrac`. Set
`ONTRAC_TRACKING_NUMBER` to check history for an authorized real parcel.
