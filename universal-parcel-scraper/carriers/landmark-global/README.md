# Landmark Global

Tracks individual LTN references through the official anonymous portal,
including the portal's canonical identity for references ending in N1. When the
user picks Landmark, or opens a Landmark link carrying one, it also takes the merchant
references the portal finds. IMX France, which sold as IMX Postal, belongs to Landmark Global
and its tracker now sends visitors to Landmark's, so those names count as Landmark's. FDM
Logistics (Freight Distribution Management) became Landmark Global – Australia, so its names
count as Landmark's too. Its former tracker still answers, but no public number shows that
Landmark's page knows FDM's references, so links to it are not read.

## How it works

One bounded GET retrieves the complete server-rendered event table. The canonical parcel
identity must match. A merchant reference must be the parcel's order or package reference,
or its delivery partner's number, which other carriers hand over, and the parcel's LTN
becomes `canonical_tracking_number`. It needs at least eight
letters and digits, one of them a digit: the page searches every merchant, so a shorter
value could be another merchant's order reference. Detection leaves merchant references out, since nothing in
them is Landmark's own. The latest summary must agree with the first scan: its clock
always, its wording when it shows one. Before the first scan has wording, and once a parcel
is sent back, the summary shows only the stage or a link to the return's own tracking.
Multi-parcel pages are rejected. An exact absence message is accepted only when
the requested reference is retained in the page's search field, and only an LTN's
absence is final. A merchant reference reaches the adapter upper-cased and without
the spaces, dots and hyphens the user may have written. The page found a reference
in lower case as well, but found no parcel by an order reference holding a hyphen,
as printed or without it, so a merchant reference's absence stays inconclusive. It carries the
reason `portal_not_found`, so a consumer can tell Landmark's answer from an outage.

## Notes

The page writes every scan's clock in US Central time, wherever the scan was, and
names its offset beside it, CDT or CST. A clock becomes an instant only when that
name is the offset Chicago keeps at that clock, which also tells the repeated autumn
hour apart. Otherwise it stays a local clock, which the host archives while it asks
providers for dated progress. The single current offset the page's script applies to
every scan is not used. Scans keep the provider's order.

The page relays the delivery partner's scans in the partner's own wording. Landmark's
wording sets the stage first, then the shared rules, for the parcel as for each scan. A
summary that reads "Returned" and links to the return's tracking makes the parcel returned,
since its own history stops before the return. The return's reference is not read.

The delivery partner's reference is its tracking link's text, kept when unambiguous. The
partner's name names the carrier unless its link is on another carrier's site; when the name
is not a catalog name, the link alone names it. A generic "Postal Carrier"
names none: its number is an international postal item that the destination's post
delivers. Of the ship-to place, only the country is read. Order references, package
references and payment actions are excluded.
Deposit permission alone does not establish delivery; only a completion scan does.

## Live test

Set `LANDMARK_GLOBAL_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/landmark-global/adapter.live.test.ts`.
Optionally set `LANDMARK_GLOBAL_UNKNOWN_NUMBER` to check explicit absence.
Set `LANDMARK_GLOBAL_ALIAS_NUMBER` to check an N1 reference against its canonical parcel.
