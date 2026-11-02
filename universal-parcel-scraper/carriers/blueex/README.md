# BlueEX

BlueEX is a courier and e-commerce logistics company based in Karachi. It collects from online
sellers and delivers documents, parcels and cash-on-delivery orders across Pakistan. Tracked
through the lookup its tracking page makes.

## How it works

1. `direct`: one `POST https://www.blue-ex.com/assets/config/tracking/trackall.php` with the form
   body `tracking_numbers[]={number}&type=blueex`, as the tracking page's script sends the number
   in its address. It needs no cookie, token, captcha, phone digits or browser. The reply is an
   HTML block for the number: its progress steps and its scans, oldest first.
2. `retry`: one more read when BlueEX cannot be reached or does not answer in time.

- A number the tracker holds no scans for gets the same block without scans or a notice, so it
  is inconclusive, never not found. Recognition makes the same request: it confirms a known
  consignment but cannot rule a number out.
- The lookup answers an input it does not take with an empty reply, which the page reports as no
  tracking information. That is inconclusive too.
- The block names the number twice, and both must be the whole number asked. The lookup does not
  answer partial or padded numbers.
- A 404 or a redirect is a moved route; a firewall page or a bot check, even with HTTP 200, is a
  challenge.

## Notes

- Each scan has a date and a minute without an offset, as `Aug 4th, 2026(03:04 PM)`. BlueEX
  scans in Pakistan, which keeps one offset without daylight saving, so every clock is read in
  Karachi time.
- Scans have no code, so their wording stages them. A station scan ends with its city after a
  comma or a dash, which is its location; `Shipment is on route to` names where it is going.
- A delivery reads `Delivered to` and who took the parcel. Only `Delivered` is kept. Phone
  numbers are taken out of every wording.
- The progress steps above the scans are not read.
- BlueEX's merchant APIs need an account and are not used.

## Limitations

- No service, weight, origin, destination, estimate or proof of delivery.
- Older consignments drop out of the tracker and then show no scans.
- Returns, consignments sent abroad and numbers starting with `CP` have not been seen with a
  history.

## Numbers

BlueEX consignment notes seen in archived lookups on its tracker are ten digits. The tracking box
takes ten digits from 4000000000 to 6999999999, or `CP` followed by twelve digits, a layout no
public sample shows; the adapter takes the same. Ten digits are printed by many carriers and no
known prefix or check digit sets BlueEX apart, so no rule claims them. Recognition can confirm a
known number, but without a rule offering BlueEX it is not asked; a caller names the carrier or
pastes a tracking page link. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The search box on blue-ex.com opens one consignment at `/tracking` with the number in
`trackno`. Former addresses took it in `cn` on `/tracking.php` and in `trackno` on
`/index.php`. The library reads the number from all three.

## Testing

`npm run test:carriers:live -- carriers/blueex`, with `BLUEEX_TRACKING_NUMBER` and optionally
`BLUEEX_UNKNOWN_NUMBER` set outside the repository.
