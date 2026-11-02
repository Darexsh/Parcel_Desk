# Team Worldwide

Team Worldwide is a US air and ground freight carrier with branch offices and its own truck
fleet. Its Team Trac page shows a shipment's status and, for deliveries by appointment, when
the terminal is scheduling the delivery. Tracked through Team Trac.

## How it works

1. `direct`: one `POST https://www.teamww.com/tracking/team-trac` with
   `hbl={number}&srn=&con=`, the form of the Team Trac page and of the tracking box on Team's
   home page. It needs no cookie, token, key or browser. The server renders an answer block for
   each bill: the shipment's header with its bill and status, and its status details newest
   first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A bill Team Trac does not know is a notice, `Status is not available for Team Bill #
  {number}`. A notice naming another bill is inconclusive. A redirect, a 404 or a 410 is a moved
  page, and a Fortinet or Cloudflare block page in place of the page is a challenge.
- The adapter sends one whole bill and reads only the block whose `Team Bill #` is that bill; a
  page without it is inconclusive and nothing from it is kept. It never fills the shipper's
  reference or the consignee's name.
- Recognition makes the same request.

## Notes

- A row's date and time have no zone, and the page names none; station codes are airport codes,
  which do not settle a zone either. Scans stay `local_time`. Rows keep the page's order.
- A row's code stages it. A delivery, from a `POD` row or the header's status, settles the
  shipment; otherwise the further of the newest staged row and the header's status decides. A
  header status ahead of every row has no clock. `(SEE REMARKS)` names no stage.
- A delivery appointment row (`ADS`) is stamped when the station booked it, so it stays in the
  history, and until the delivery the newest one's day is the estimate. Without one, the
  estimate is the header's `Requested Delivery` day, which the page calls an estimate. A day
  before the newest row's is stale. The estimated arrival at the destination terminal is not a
  delivery estimate and is not read.
- A town and state after a row's wording, `OUT FOR DELIVERY - {town}, {state}`, is the row's
  location. Other text after the wording, the appointment window and the booking agent who
  follows it, and the signer after `SIGNED FOR` are not kept.
- Remarks (`FRE`, formerly `CMT`) are free text the station types and can name people, so they
  are left out of the history.
- The shipper's reference, the town and ZIP code the shipment goes to, the delivery's clock in
  the header and the office's phone number are not kept.

## Limitations

- No weight, piece count, service, sender or recipient, and no scan time as an instant.
- A bill reaches the adapter when it is filed under Team Worldwide or opened from a Team Trac
  link: station codes are airport codes other carriers print too, so no rule claims them and
  preflight does not ask it.

## Numbers

Team Trac answers for bills of a station code and six digits, sometimes with a closing letter;
of a two-digit year, a station code, a letter and six digits; and of a station code before a
shipper's own reference. It names the signer of each public sample of the first two layouts, in
its archived lookups or live, so [`numbers.json`](numbers.json) holds invented bills of those
shapes next to archived samples of the third.

## Links

Archived Team Trac lookups open one shipment at
`www.teamww.com/wp-content/tracking/teamTrac.php?hbl={number}`, the answer block alone. An
older results page took the same `hbl` parameter and now redirects there. The library reads
the number from both.

## Testing

`npm run test:carriers:live -- carriers/team-worldwide`, with `TEAM_WORLDWIDE_TRACKING_NUMBER`
and optionally `TEAM_WORLDWIDE_UNKNOWN_NUMBER` set outside the repository.
