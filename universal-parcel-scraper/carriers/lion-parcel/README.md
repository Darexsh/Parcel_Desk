# Lion Parcel

Lion Parcel is the parcel service of the Lion Air group, with agents and warehouses across
Indonesia and an international service. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://lionparcel.com/api/tracking?q={number}&captcha_token=&country=ID`,
   as the tracking page's script asks for the numbers in its address. The page sends a
   reCAPTCHA token, which the service does not check, so the token is left empty; the request
   needs no cookie, key or browser. The JSON reply has one entry per number asked, with the
   service, the summary status code, a delivery window and the scans, oldest first.
   The service answers 403, "Forbidden: External access not allowed", when the request's fetch
   metadata says it comes from another site, as Node's `fetch` does by default, so the request
   carries the page's own `Sec-Fetch-Site: same-origin`.
2. `retry`: one more try when the request fails to reach the site or hangs. The first try gets
   half of the budget.

- An unknown number is HTTP 200 with an entry that echoes it, has no STT and found nothing,
  which the page reports as "Hasil pencarian tidak ditemukan". A 404 or a redirect is a moved
  route; the site redirects routes it does not know to its home page.
- The tracker also finds a shipment by its booking code, so an entry counts only when its own
  `stt_id` is the number asked.
- A browser check from a CDN or firewall in place of the reply is a challenge.
- Recognition makes the same request.

## Notes

- Each scan's `status_date` is a moment with an offset, and `GMT` names the scanning site's
  zone, such as `GMT+8:00` in central Indonesia. The page shows the moment in that zone, so
  scans are returned at that offset. Scans before an agent or a courier takes the parcel name no
  zone and keep the reply's own offset, usually UTC.
- Scans have a code and Indonesian wording. The codes are staged by what their scans say,
  because the tracker's own summaries group them coarsely: arrival at the destination's
  warehouse and customs sit with out for delivery there, and a claim with returns. The summary
  code decides the stage, then the newest staged scan. A price adjustment for the parcel's
  weight moves nothing.
- A scan's location is the facility's city after its three-letter code. The pickup scans name
  the sender's district instead, which is not kept.
- The courier's name and the person who took the parcel are taken out of the wording. The
  sender's and the recipient's districts, payment flags, the booking code and delivery photos
  are not kept.
- The delivery window is kept while the parcel is on its way, unless it ended before the newest
  scan's day.

## Limitations

- A shipment moved to a new STT, as for a return, is not followed.
- Older parcels lose their scans and then drop out of the tracker, which then answers as for an
  unknown number. A parcel listed without scans is returned as a summary.
- No weight, sender or recipient.

## Numbers

Lion Parcel STT numbers are two digits, `LP` and thirteen digits. They appear in archived
lookups on Lion Parcel's tracker and its tracking API, in complaints that name Lion Parcel and
in Indonesian tracking guides, with the prefixes `11`, `88` and `99`. Rule `lion-parcel-1`
claims the layout with high confidence because the `LP` infix points to Lion Parcel alone.
Colis Privé's broad seventeen-character rule also takes many of these numbers, which the
collision registry records. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

Lion Parcel's tracker builds `lionparcel.com/track/stt?q={number}` and opens the parcel from
the `q` parameter, which takes several numbers separated by commas; the library reads the
number from that address and from its `/my/track/stt` variant.

## Testing

`npm run test:carriers:live -- carriers/lion-parcel`, with `LION_PARCEL_TRACKING_NUMBER` and
optionally `LION_PARCEL_UNKNOWN_NUMBER` set outside the repository.
