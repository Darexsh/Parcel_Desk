# DHLink

DHLink (驼飞侠), DHgate's logistics arm, takes marketplace parcels in at its warehouses in China
and the United States and sends them on its own lines or through posts and line providers to a
last-mile partner such as USPS, Royal Mail or SwiftX. Tracked through the lookup its tracking
page makes.

## How it works

1. `direct`: one `POST https://www.dhlink.com/stage-api/trbiz/track/queryTrack` with
   `{"trackNos":[number],"state":"","language":"EN"}`, as the tracking page's script sends it.
   It needs no cookie, token, key, account or browser. The JSON reply holds the parcel's
   numbers, countries and rows.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- The lookup finds a parcel by its tracking number. A DHLink number (FC and thirteen digits)
  finds it only when it is also the tracking number, as on DHLink's own line; the last leg's
  number finds nothing. A line provider's number can be the tracking number: `XZG`, nine
  digits and `WL` is one; `YLUS` and ten digits, `QH`, twelve digits and `FS`, and `YF`, ten
  digits and `CN`, on US lines GOFO delivers, `EYT`, ten digits and `HZ`, and KTD's `KTDWE`
  and ten digits, on lines SwiftX delivers, and `YHKJ` and ten digits, on a line to Britain,
  are others. Boyuan's `BY`, fourteen digits and `CN`, which ParcelsApp attributes to DHLink
  on a US line, and Tuodatong's `TDT`, ten digits and `CN`, which it attributes to DHLink on an
  air line from China, are asked too, as is `YLE`, two letters, ten digits and `YQ`, a line ParcelsApp names
  YLE beside DHLink. Their rules are low confidence, so
  DHLink is asked before it is named. Providers name XZG for its numbers, so XZG is an
  alias and their hint asks DHLink.
- The parcel counts only when the number asked is its tracking number or its DHLink number:
  the search can find a parcel by its other numbers.
- An empty parcel with state 1 is the unknown-number answer. For a DHLink number or a last
  leg's number in the partner table it is inconclusive, since the search gives it for parcels it has too. It
  then carries the reason `portal_not_found`, so a consumer can tell DHLink's answer from an outage. A
  refusal in the envelope, or a parcel without rows, is inconclusive.
- DHLink's firewall answers clients it refuses, such as a headless browser's User-Agent, with a
  block page and HTTP 403, on the page and the lookup alike. A block is a challenge, never a
  missing parcel. Redirects are not followed.
- Recognition makes the same request.

## Notes

- Each scan comes once per feed that relays it: DHLink's own, the post's in English and in
  Chinese, the line providers'. One feed can send a scan in two formats. Rows that share a
  clock are one scan; the adapter keeps the row with DHLink's node, else English, else a place,
  else the longest wording. DHLink's own export clearance and airport rows in Chinese show the
  English its nodes give them, and a wording in both languages shows its English half.
- A row with a node is read by its code, else by the node's name. Other rows are read by
  DHLink's wordings, GOFO's relayed ones and China Post's Chinese ones, else by the shared
  rules, which read the other partners' relayed English. The hand-over to the US partner ("delivered to UPS/USPS/Fedex"),
  the last-mile partner's pickup and China Post's hand-over to the airline are transit.
  DHLink's delivered count makes the parcel delivered when the last row says less.
- A line on the Hualei platform writes an order row (`货物电子信息已经收到`) when the parcel's data
  reaches it, and a partner a label. Before any scan they are registered; written after DHLink
  took the parcel they are no step back, as for every carrier
  ([ARCHITECTURE.md](../../ARCHITECTURE.md#status-model)). A receipt after the parcel moved on,
  such as China Post's once the warehouse sent it off, is transit.
- Clocks have no offset. DHLink records each row on Beijing time (`createDate`), seconds after
  the clock of a row scanned in China. A scan with a place in China is read on Beijing time.
  So is every scan of a parcel whose last leg is GOFO or SwiftX: DHLink relays their scans on
  its own clock, however late it records them. GOFO's own feed gives the same instants, and
  SwiftX's rounds and deliveries are recorded before a US reading of their clocks. DHLink's own
  row of GOFO's pickup (`TQ001`) is the exception when it names GOFO's hub: it is GOFO's
  arrival there, at the hub's wall clock. A partner's copy of a scan DHLink records can come
  too, on the partner's US clock, as SwiftX's hub scans do; a scan whose US reading is the
  instant of another with the same wording is that copy and is dropped. With another partner or
  none known, that other row must be read on Beijing time, as a pickup row recorded at once
  is. Otherwise a scan a USPS
  office names with its state and ZIP code, or that pickup, is read on that state's time, unless
  the state spans several zones. A scan recorded before its clock could have struck at the
  destination, even in the destination's easternmost zone, keeps DHLink's own Beijing time. Any
  other scan could be on either clock and keeps its wall clock in `local_time`; the newest
  scan's instant, when it has one, is the last update.
- A row still after the read at UTC+14, the earliest instant it can stand for, is dropped, and
  the delivered count is then not trusted. So is the flight DHLink books the parcel on
  (`预计配载航班…`, "Expected flight on …" or "Estimated loading flight time …"): it is written
  before the flight and is no scan.
- The reply gives the last leg's number (`lastTurnNo`) but no partner, so the partner comes from
  the number's whole layout in an explicit table: `SWX` and eighteen digits is SwiftX, `GFUS`
  and fourteen digits is GOFO, and fourteen digits from depots 0600 to 0619 is DPD
  Switzerland. Other numbers give no hand-off; parcels USPS or a post delivers give no
  last-leg number.
- Places lose postcodes, placeholders and the destination code feeds append to Chinese places,
  whether written in Chinese or as a province or city in Latin letters ("SHENZHEN, US"). A
  place naming only the destination country is the parcel's, not the scan's: a Canada line's
  airline hand-over in China reads "Canada". It is left out, and a scan stored with it keeps
  its row.
  Wordings lose US ZIP codes, British and Canadian postcodes, contact or signature details a
  post appends, and the row's own clock a node's wording ends with ("Shipment has delivered
  at …"); a scan stored with that clock keeps its row. The order id, the DHLink number and
  the feeds' and rows' ids are never read.
- The destination is the reply's `destCountryCode`, where DHLink writes Britain as UK; it is
  read as GB.
- The tracking link adds `lang=en`: the page shows Chinese otherwise.

## Limitations

- No delivery estimate, delivery time, weight, service, sender or recipient.
- A parcel asked by its DHLink number is inconclusive when it has another tracking number.
- The share links on tr.dhlink.com need DHgate's order id, which the adapter never sends.
- The progress rail and the origin are not read.

## Numbers

DHLink is DHgate's logistics platform. Its tracker labels its own logistics number, `FC` and
thirteen digits, as the DHLink number. On some channels that number is also the tracking
number, as on a parcel ParcelPanel's DHLink page offers. `dhlink-1` suggests DHLink for it at
low confidence, since a two-letter prefix and a digit run can come from other systems. Other
parcels travel under the international number of the line DHLink books: a China Post number,
which postal detection handles, or a line provider's number in the same layout whose check
digit fails, which no rule claims. The tracker also gives the last-mile partner's number.

## Testing

`DHLINK_TRACKING_NUMBER=... DHLINK_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/dhlink`
