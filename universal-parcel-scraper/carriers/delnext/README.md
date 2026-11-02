# Delnext

Delnext is a Portuguese courier that collects in mainland Portugal and Spain and delivers
there and across the EU, handing some international parcels to partner networks. Tracked
through its tracker's page.

## How it works

1. `direct`: one `GET https://www.delnext.com/PT/track_your_parcel?tracking_code={number}&reloaded=PT`,
   the address the tracker's form ends on. It needs no cookie, token or browser. Without
   `reloaded`, the site answers a known code with a script that loads the same address with
   it. The server-rendered page in Portuguese names the code asked and lists the parcel's
   scans, newest first, each with a day, a time, a place and a line.
2. `retry`: one more try when the request fails to reach Delnext or hangs. The first try gets
   half of the budget.

- The page's header must name the code asked.
- An unknown code gets the tracker's empty search page, whose script still holds the code
  asked: not found. A 404 or a redirect is a moved tracker.
- A page without the header is a Cloudflare check when it looks like one, and the site's own
  database or resource-limit notice is an outage. The page loads reCAPTCHA for its login form,
  so that alone is no check.
- Recognition makes the same request.

After an identified browser challenge, `trawl` opens the same tracking address in the
configured browser service. The carrier parser checks the whole shipment identity.
Definite answers, rate limits and malformed replies do not launch a browser.
Recognition stays HTTP-only.

## Notes

- Times have no zone. Delnext collects in Spain and its scans name towns abroad, so they stay
  wall clocks.
- The lines are mapped in [status.ts](status.ts). A line under a failed delivery saying the
  recipient or the system booked a new day is dropped; the scans after it show the new round.
  The notice after a new delivery date and the delivery proof button are dropped too.
- The page lists scans of the same minute in no fixed order, so a delivery or a return at the
  newest minute decides the parcel's stage.
- The progress bar's last step can contradict the scans, so only its delivery estimate is
  read, while the parcel still moves.
- A cancelled parcel has one line without a day, which is its state.
- A parcel a partner delivers has no scans of Delnext's own. The header names the partner and
  the parcel is in transit. When that partner is DPD Germany, DPD France or MRW, a hidden
  notice on the page names the same partner and its number has that partner's shape, the
  partner and its number are handed off. The notice often holds a stale partner or a
  placeholder, so it is not read alone.
- The destination town, the recipient's name and signature in the proof of delivery, and the
  forms to change a delivery are not read. Those forms ask for the recipient's postcode or
  phone; the adapter never opens them.

## Limitations

- No weight, service, delivery time as an instant, or scan codes.
- Older parcels drop out of the tracker. Some keep a page without scans, which is no
  history; others get the empty search page.
- DPD France's numbers on these pages are eighteen digits, which the DPD France adapter does not
  take, so those parcels are not handed off.

## Numbers

Delnext's tracking code is six capital letters and digits, the layout of every archived
lookup on its tracker and of complaints on Portal da Queixa. Two complaints quote seven
characters. No rule claims either: short letter-and-digit codes are shared with other
carriers' references and point to no carrier. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker form sends the code as `tracking_code` to `/<language>/track_your_parcel` on
`www.delnext.com`, so `www.delnext.com/PT/track_your_parcel?tracking_code={number}` opens
one parcel. Archived lookups also put the code in the path, after `tracking_code/`.

## Testing

`npm run test:carriers:live -- carriers/delnext`, with `DELNEXT_TRACKING_NUMBER` and optionally
`DELNEXT_UNKNOWN_NUMBER` set outside the repository.
