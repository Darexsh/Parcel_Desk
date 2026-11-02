# WINIT

WINIT (万邑通) is a Chinese cross-border e-commerce logistics company. It stores sellers' goods in
overseas warehouses in the US, the UK, Germany and Australia, packs each order there and hands it
to a local courier such as UPS or FedEx. Tracked through the lookup its tracking pages make.

## How it works

1. `direct`: one `POST https://track.winit.com/tracking/Index/getTracking` with the form body
   `trackingNoString={number}`, as the mobile and desktop result pages send it. It needs no
   cookie, token, key or browser. The JSON reply lists the shipment for each number asked, in
   the page's tabs and in `all`, with its scans oldest first.
2. `retry`: a request that fails to reach the site, or hangs, gets one more try in the rest of
   the budget.

- An unknown number is HTTP 200 with a line for it whose `findNoBl` is `N`. The lookup is case
  sensitive, so the adapter sends capitals. A 404 or a redirect is a moved route.
- Huawei Cloud's firewall is in front of the site. Its page in place of the JSON reply is a
  challenge.
- The lookup also finds a shipment by its courier's number. A shipment counts only when its own
  package or order number is the one asked. An order with several packages names no single
  parcel and is inconclusive.
- Recognition makes the same request.

## Notes

- `S` scans are WINIT's warehouse scans and carry the warehouse's zone, which places their wall
  clocks. `V` scans are the courier's, relayed. FedEx's come with their offset from UTC and are
  placed. UPS's come labelled with the warehouse's zone even when scanned in another country, so
  they keep their wall clocks.
- WINIT's codes stage its warehouse scans. `DIC`, "Awaiting pickup", waits for the courier to
  collect the parcel, not for the recipient, so it is accepted. The courier's codes are not kept;
  its wording goes to the shared rules.
- The Delivered, Undelivered and Alert tabs decide the stage, unless a courier scan says the
  parcel waits at a pickup point or goes back.
- The shipment names the courier and the courier's number. The number is the hand-off for a
  tracked service. The courier is named only when the catalog knows it and its rules take the
  number. A USPS routing barcode gives its package identifier.
- Relayed UPS wording arrives with its trademark sign read as Latin-1; the adapter puts it
  right.
- Staff logins, the recipient's town and postcode, proof of delivery, postcodes in courier
  locations, the person who signed and phone numbers are not kept.
- The delivery estimate is a day, as the desktop page shows it.

## Limitations

- No weight or service name.
- A parcel delivered by UPS has no delivery instant, since UPS's scans keep their wall clocks.
- The tracker forgets old shipments: the older archived samples are unknown to it now.

## Numbers

WINIT's tracker answers its own numbers. Overseas warehouse orders read `WO` and ten or eleven
digits, and each package adds a letter; `winit-3` claims package numbers. Order numbers without
the letter share their shape with Colis Privé, Aramex and La Poste references, so no rule claims
them and the user picks WINIT. Older China pick-up orders read `ID`, fourteen digits and a
country code, and older warehouse orders `WO`, eleven or fourteen digits and the warehouse
country; `winit-1` and `winit-2` claim those. The courier's own number stays with that courier.
The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The mobile tracker opens one parcel at
`track.winit.com/tracking/Mobile/result?trackingNos={number}`, the address its own search form
builds. Desktop result pages carry the number after `trackingNoString/` in the path, and the
mobile detail page after `traceDetail/trackingNo/`.

## Testing

`npm run test:carriers:live -- carriers/winit`, with `WINIT_TRACKING_NUMBER` and optionally
`WINIT_UNKNOWN_NUMBER` set outside the repository.
