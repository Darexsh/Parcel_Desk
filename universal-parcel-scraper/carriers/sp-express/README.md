# SP Express

SP Express, formerly Świat Przesyłek, is a Polish postal operator and consolidator. Its Nysa
hub takes parcels from Polish senders and from Cainiao's economy flow and hands them to partner
networks for final delivery, so the history it shows often comes from those partners. Tracked
through its tracker's own page.

Royal Shipments was its English-language brand: royalshipments.com redirects to the tracker and
keeps the `/tt/` path, so its name and links route here.

## How it works

1. `direct`: one `GET https://en.sp.express/tt/{number}`, or `/tt-cainiao/{number}` for a
   Cainiao parcel. It needs no token, key or browser. The server renders the parcel's progress
   rail, its current status, its history newest first, its order details and a Reference link
   that opens the number.
2. `retry`: one more attempt after a failure to reach the tracker, inside the budget.

- An unknown number is HTTP 302 back to the search page, `/tt` or `/tt-cainiao`, in a new PHP
  session. The adapter opens that page once with the session cookie and reads its notice
  `Shipping not find the specified ID!` as not found. A redirect anywhere else, a missing
  cookie or a page without the notice is inconclusive. A 404 is a moved route.
- The Reference link must open the number asked, on the page it was asked on.
- Recognition makes the same request.

## Notes

- Scan clocks are wall clocks with no zone, from the Nysa hub and from the partners abroad, so
  they stay `local_time` and the page's order stands. Newer pages give the minute, older ones
  the second. The hub's manifest and inbound scans come at midnight and are kept as a day.
- The tracker has two layouts. One has a place column; the other puts the place in brackets
  after the wording, as `In Transit (Nysa)`. The place is kept as the location. Brackets that
  hold a reference, such as a Cainiao consignment, or who signed are dropped, and so is a place
  column that names who signed.
- Wordings are the tracker's own steps in English and the partners' scans it relays, in
  English or Polish and in any letter case, mapped in [`statuses.json`](statuses.json).
- The history of an older parcel is archived: the page then shows only the status bar, without
  a clock. The adapter returns that status as a summary. When the map and the shared rules do
  not know the status, the furthest lit step of the progress rail gives the stage.
- Of the order details, the weight, the size and the receiver's country are kept. The
  postcodes beside the countries, the sender's country and the sending date are not.
- A box links to the delivering partner's tracker, but the page never gives the partner's
  number, and on the Cainiao page the link can name a post that does not serve the destination,
  so there is no hand-off.

## Limitations

- No delivery time as an instant, no estimate and no partner number.
- An older parcel's history is not available, only its last status.
- The tracker also finds a parcel by its delivery partner's number. The adapter takes SP
  Express's own numbers and Cainiao's only.
- The portal link opens `/tt/`, which does not know Cainiao parcels.

## Numbers

Its own order numbers are fifteen digits: 483, the sending date as YYMMDD and six digits.
Archived lookups on its tracker show this layout, and the opened ones carry a sending date that
matches the middle digits. `sp-express-1` suggests SP Express for it at low confidence, because
BRT and Yunda accept any fifteen digits, and recognition asks the tracker.

Its Cainiao page tracks a destination country code and twelve digits. Too few of these are
known to tie the layout to SP Express alone, so no rule claims them; the adapter takes them
when the parcel is filed under SP Express or comes from a `/tt-cainiao/` link. Partner numbers
that its tracker also accepts are not its own. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`sp.express/tt/{number}` and `en.sp.express/tt/{number}` open one parcel, as did the former
swiatprzesylek.pl host, which now redirects to sp.express. Cainiao parcels open at
`/tt-cainiao/{number}`. A `/tt/` link names SP Express for whatever number it carries, so a
partner's number in it fails the adapter's number check and falls to enabled universal
providers.

## Testing

`npm run test:carriers:live -- carriers/sp-express`, with `SP_EXPRESS_TRACKING_NUMBER` and
optionally `SP_EXPRESS_CAINIAO_NUMBER` and `SP_EXPRESS_UNKNOWN_NUMBER` set outside the
repository.
