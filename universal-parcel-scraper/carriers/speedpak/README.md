# SpeedPAK

Tracks Orange Connex SpeedPAK cross-border shipments through the public website's anonymous JSON endpoint.

## How it works

1. `direct`: POST one number and the English locale to the website's tracking service. The returned waybill must match the requested number before any history is retained.

The carrier provides epoch timestamps for scans, so cross-border events keep their instants without imposing a China timezone.

Each scan is classified by its English wording, else by SpeedPAK's own Chinese label (`eventDescCn`). The label stays in SpeedPAK's vocabulary when the English text is the last-mile carrier's own wording, such as USPS's upper-case scans. The line naming the last-mile carrier and its reference is in transit by its own wording: SpeedPAK files it under 同步尾程供应商, its hand-over to that carrier, but does not always send that label with it.

SpeedPAK can send its Chinese label as the English wording too, such as 货物运输中; the adapter shows its English. A scan's place is its city and country, but a partner's scan can give a country's code as its city and the destination as its country, before the parcel leaves for it: the code is where the scan happened, and it is the place. A departure for the destination country that gives no such code has no place: the country it names is where the parcel goes.

Labelled last-mile references, in English or Chinese, are retained for handoff discovery. A USPS routing barcode opens with the recipient's ZIP code, so the hand-off line, the status summary and the reference keep only the package identifier after it (`wording.ts`); the identity policy in `identity.ts` lets a line stored with the barcode take the trimmed wording. The named carrier is reported when the catalog knows it and its detection offers the reference. Conflicting references do not select a partner. `delivered_at` is the newest scan's time when it is a delivery.

Orange Connex tracking links (`orangeconnex.com`, `orangeconnex.cn`) name SpeedPAK only for a number its detection claims (`ownNumbersOnly`). Any other number they hold is detected on its own.

## Limitations

Only SpeedPAK identifiers are accepted; `EX` numbers seen in archives are not, and the tracker answers not found for them. Older numbers expire within months. Recipient postcodes are discarded. An unknown status remains unmapped, and a missing scan timestamp stays unresolved.

## Testing

`SPEEDPAK_TRACKING_NUMBER=... npm run test:carriers:live -- carriers/speedpak`
