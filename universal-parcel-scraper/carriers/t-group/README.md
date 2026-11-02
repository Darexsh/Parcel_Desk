# Tgroup

Tgroup is an Italian express courier and distribution company with its own vehicles and
branches, covering most Italian provinces directly. Tracked through the tracker page the search
box on its home page opens.

## How it works

1. `direct`: one `GET https://track.tgroupspa.com/ttnet/traccia_spedizione/{number}`. It needs
   no cookie, token, key or browser. The tracker renders the page on its server: a tab with the
   scans, oldest first, each with its wording, clock and branch, and a tab with the shipment's
   details.
2. `retry`: one more attempt after a network failure.

- A number the tracker holds nothing for gets HTTP 200 with "NUMERO SPEDIZIONE NON TROVATO"
  instead of the tabs, which is not found. A 404 or a redirect is a moved route, and a bot
  check's page is a challenge.
- The page does not repeat the number: it answers for the one number its address names. A page
  with several shipments is inconclusive.
- Recognition makes the same request.

## Notes

- Scan clocks are shown to the minute without a zone. Tgroup works in Italy only, so they are
  read as Rome time; the hour the clocks repeat reads as its first occurrence.
- The scans carry no code; their wordings are mapped and any other goes to the shared wording
  rules. The icon beside each scan is not read.
- A scan's place is its branch's code and town, `code - TOWN`. The town is kept. The delivery
  round's scan names none.
- The weight and the planned delivery day (`Data scarico prevista`) are kept; the planned day
  stays on the page after the delivery, so it is dropped then. The sender's and recipient's
  postcodes and towns, the branch's shipment number, the delivery note, the parcel count, the
  volume, the freight terms and the loading day are not kept.
- The page names no other carrier or number, so there is no hand-off.

## Limitations

- No provider codes, offsets, pickup point or proof of delivery.

## Numbers

Shipment numbers on Tgroup's tracker are `3010TGR` and fourteen digits, as an archived lookup
on the tracker shows; `3010` is also the code of Tgroup's database on its tracking platform.
`t-group-1` claims that form at high confidence, so recognition is not needed to settle it. The
branch shipment number and the delivery-note number the tracker also shows are not searched.

## Links

The search box on Tgroup's home page opens `track.tgroupspa.com/ttnet/traccia_spedizione/`
with the number as the last path segment, so that address opens one parcel. The library reads
the number from it.

## Testing

`npm run test:carriers:live -- carriers/t-group`, with `T_GROUP_TRACKING_NUMBER` and optionally
`T_GROUP_UNKNOWN_NUMBER` set outside the repository.
