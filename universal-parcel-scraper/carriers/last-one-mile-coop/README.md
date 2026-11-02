# Last One Mile Co-op

Last One Mile Co-op (ラストワンマイル協同組合) is a cooperative of Japanese local delivery companies.
It takes parcels in at its centres and hands each to the member company that delivers it.
Tracked through its inquiry form on Yamato System Development's tracker.

## How it works

1. `direct`: one `GET https://y-track.jp/ytrack/inqservlet?cd=81118&id=02116&number01={number}`,
   the co-op's form with the waybill filled in, as the co-op's links open it. The tracker renders
   the page on its server: a list with a row for each number asked, then the details and the
   history of each parcel found. It needs no cookie, token, key or browser.
2. `retry`: one more request after a network failure or a timeout.

- The page is read in the charset its Content-Type or its meta tag declares. The tracker
  declares Shift_JIS.
- The tracker hosts other companies' forms, so the form's hidden `cd` and `id` must be the
  co-op's.
- The list's row, the heading over the details and every history row must name the number asked.
- An unknown number is HTTP 200 with "送り状番号未登録" as its state in the list and no details.
  Only that answer, for the number asked, is not found. The tracker gives it for any input, so a
  number that is not twelve digits with the check digit is refused before a request.
- A browser check or a firewall refusal, with HTTP 200 or 403, is a challenge. A redirect or a
  404 is a moved page.
- Recognition makes the same request.

## Notes

- A history row has the state, the day and the time to the second, the companies, the office
  and the waybill numbers. Every centre and member company is in Japan and the page prints the
  year, so a row's time is an instant in Asia/Tokyo.
- The list's state is the co-op's current one and decides the stage. The newest staged row
  decides only a state the map does not know. The tracker has no codes; [`status.ts`](status.ts)
  stages the states by their wording.
- 引受 comes twice: when a co-op centre takes the parcel in, and when the member company that
  delivers takes it over after the headquarters' hand-over notice (中継連絡).
- The rows name the member company that delivers and its waybill number, which is the co-op's
  own. No member company is a carrier of the catalog, so no delivery partner is proposed, and
  the companies are not kept.
- The delivery day and the weight, which the page leaves empty, the parcel count, the offices'
  contact links and the drop-off (置配) button are not kept.
- Waybill numbers come round again: an archived lookup and the tracker's answer today for the
  same number can be different parcels. A page with two parcels under the number is inconclusive.
- The co-op's LINE account also looks waybills up, behind a LINE login.

## Limitations

- No delivery estimate.
- Preflight does not ask the co-op about a number, because no detection rule offers it (see
  Numbers). A number filed under the co-op is tracked directly.

## Numbers

The tracker takes a twelve-digit waybill whose last digit is the remainder of the first eleven
divided by seven, the check Yamato, Sagawa and Japan Post waybills use. Archived lookups show
the parcel accepted at a co-op centre and handed to the member company that delivers it.

The shape and check digit are shared with those larger carriers, so no rule claims these
numbers. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

The co-op's pages link to an inquiry form at `y-track.jp/ytrack/inqservlet?cd=81118&id=02116`,
and archived lookups add the waybill as `number01`, so
`y-track.jp/ytrack/inqservlet?cd=81118&id=02116&number01={number}` opens one parcel. The form
only works with its query string, so there is no search page without one.

## Testing

`npm run test:carriers:live -- carriers/last-one-mile-coop`, with
`LAST_ONE_MILE_COOP_TRACKING_NUMBER` and optionally `LAST_ONE_MILE_COOP_UNKNOWN_NUMBER` set outside
the repository.
