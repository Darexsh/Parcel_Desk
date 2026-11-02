# DX

DX, a UK courier for business parcels, freight and secure deliveries. DX Freight consignments
are tracked with their delivery postcode through the lookup DX's tracking page hands them to.
DX's other trackers are left to enabled universal providers.

## How it works

1. `direct`: `GET https://dx-track.com/track/dx.aspx?consno={number}&postcode={postcode}`, the
   address `my.dxdelivery.com` sends a freight consignment to. The ASP.NET page opens a session
   and redirects to `/track/Menu.aspx`, or to `/track/TrackingError.aspx`. With the session's
   cookie, the adapter then reads `Menu.aspx` for the delivery date and `/track/Track.aspx`,
   the page the menu's history button opens, for the scans. It needs no key, account, CAPTCHA
   or browser.
2. `retry`: one more try in a new session when a request fails to reach DX or hangs. The first
   try gets half of the budget.

- Every lookup needs the postcode, but a consignment can be added without one. Without it the
  adapter makes no request and reports `input_required`, and enabled universal providers
  answer instead. The tracking page checks only that a freight postcode has two to eight
  characters, so the catalog takes any country's.
- The postcode's space is sent as `%20`. The tracker matches `+` against no postcode.
- An unknown number, a wrong postcode and a delivery more than 30 days old get the same
  notice, so it is `indeterminate` (`portal_not_found`). A page redirecting to that notice
  after the lookup lost its session is `indeterminate` (`session_rejected`).
- Failures of the lookup drop the request and response details `fetchBounded` attaches: the
  address holds the postcode.
- Both pages must name the requested consignment, otherwise the answer is inconclusive.
- There is no recognition, since every lookup needs the postcode.

## Notes

- The scans carry no codes, so their wording gives the stage. A delivery of fewer items than
  the consignment holds leaves it in transit.
- A delivery scan names whoever signed for it. The name is cut from the wording.
- Clocks are the depot's wall time without an offset, printed with a two-digit year and a
  12-hour clock.
- The menu gives the planned delivery day as a weekday, a day and a month. The year is the
  one, in the despatch's year or the next, whose calendar gives that weekday within three
  months of the despatch. A day the newest scan has passed is not kept, nor is one for a
  delivered consignment.
- The service and weight are kept. The order number, item count, despatch date and the
  menu's delivery options are not.

## Limitations

- No tracking without the postcode.
- The tracking page also takes `IRELAND` as a postcode. The catalog's postcode check needs a
  digit, so those consignments are left to other sources.
- Twelve-digit Network Services numbers and secure delivery references, including the
  ten-digit numbers in DX's delivery emails, are not read. `my.dxdelivery.com` serves them
  from `POST /nstracking/trackinginfo` with `t`, the number alone, and from
  `POST /securedelivery/GetDelivery` and `POST /securedelivery/TrackingHistory` with `t` and
  the postcode `p`. Their result pages could not be observed: the public secure numbers carry
  no postcode, and no public Network Services number was found. Akamai serves that host to
  Node's `fetch` and to a full Chromium, but sends curl a proof-of-work page.
- DX publishes no consumer tracking app.

## Numbers

DX's tracking page reads its routing patterns from `/jsoptions/`: a letter and seven digits,
or eight digits, go to DX Freight, twelve digits to DX Network Services and any other
reference to its secure delivery tracker. `dx-1` suggests DX for a `C`, `L` or `W` and seven
digits at low confidence, because GLS references share the length. Ten digits are not
claimed.

## Links

DX now trades from `dxlogistics.com`, whose tracking form still sends the number to
`my.dxdelivery.com/query?tracking_number={number}`. That address redirects to
`my.dxdelivery.com/t/{number}`, the form DX's delivery emails link to.

## Testing

`npm run test:carriers:live -- carriers/dx`, with `DX_POSTCODE` and `DX_TRACKING_NUMBER` or
`DX_UNKNOWN_NUMBER` set outside the repository. Freight lookups find only consignments
delivered in the last 30 days.
