# AIT Worldwide Logistics

AIT Worldwide Logistics is a US logistics company with a home delivery service for big and bulky
goods. Its FasTrak page shows a shipment's progress and invites the recipient to schedule the
delivery. Tracked through FasTrak.

## How it works

1. `direct`: one `GET https://fastrak.aitworldwide.com/?trackingnumber={number}`, the page the
   tracking box on AIT's website opens. It needs no cookie, token, key or browser. The server
   renders each shipment it finds with its progress, its delivery panel and its history, which
   sits as data in the history grid's settings, newest first.
2. `retry`: one more request when the first fails to reach the site or hangs. The first gets
   half of the budget, so the retry fits in the rest.

- A number FasTrak does not know is a warning, `Tracking Number(s) Not Found: {number}`. A
  warning naming only other numbers is inconclusive. A redirect, a 404 or a 410 is a moved page,
  and a Cloudflare or Incapsula check in place of the page is a challenge.
- FasTrak also finds shipments by their shippers' references, so a page can list several
  shipments, or other people's shipments only. The adapter keeps the one whose bill number is
  the number asked, with the history the page binds to that number; a page without it is
  inconclusive and nothing from it is kept.
- The adapter sends whole bill numbers only. It never uses the delivery scheduling or the email
  alert form.
- Recognition makes the same request.

After an identified browser challenge, `trawl` opens the same tracking address in the
configured browser service. The carrier parser checks the whole shipment identity.
Definite answers, rate limits and malformed replies do not launch a browser.
Recognition stays HTTP-only.

## Notes

- A row's clock is a wall time to the second without a zone, and the page names none, so scans
  stay `local_time`. Rows keep the page's order.
- A row's code stages it; its wording can change under the same code. `EMAILED INFO` moves
  nothing.
- A delivery appointment row is stamped with the start of its window, so it is an estimate and
  not a scan: it is left out of the history, and until the delivery the newest one's day is the
  estimate. Without one, the estimate is the page's "Deliver By" day, which has no year; it is
  read in the year nearest the newest row's whose calendar has that weekday.
- The progress meter over the history runs from `Initiated` to `Delivered`. A delivery, from a
  row or the meter, settles the shipment; otherwise the further of the newest staged row and the
  meter decides. A meter step ahead of every row has no clock.
- The town the shipment is delivered to, who signed for it, the office's phone number and the
  rows' explanations are not kept, nor are the scheduling invitation and links.

## Limitations

- No location, weight, service, sender or recipient.
- A number reaches the adapter when it is filed under AIT or opened from a FasTrak link: bare
  digit runs are shared by many carriers, so no rule claims them and preflight does not ask it.

## Numbers

Archived FasTrak lookups show AIT bill numbers of seven to nine digits; the former tracker
accepted up to ten letters and digits. FasTrak names the signer of each public sample of the
current tracker, in its archived lookups or live, so [`numbers.json`](numbers.json) holds an
invented bill of the current shape next to the former tracker's samples.

## Links

The tracking box on AIT's website sends the number as `trackingnumber` to
`fastrak.aitworldwide.com`, so `fastrak.aitworldwide.com/?trackingnumber={number}` opens one
shipment. Archived lookups spell the parameter `TrackingNumber`; the library reads the number
from either.

## Testing

`npm run test:carriers:live -- carriers/ait-worldwide`, with `AIT_WORLDWIDE_TRACKING_NUMBER` and
optionally `AIT_WORLDWIDE_UNKNOWN_NUMBER` set outside the repository.
