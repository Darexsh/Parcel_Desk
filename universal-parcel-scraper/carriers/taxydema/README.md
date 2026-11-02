# Taxydema

Taxydema is a Greek courier with its own branches and hubs across the country. It delivers in
Greece parcels Meest International sends there. Tracked through its tracking page's own lookup.

## How it works

1. `direct`: one `GET https://www.taxydema.gr/api/track-request/{number}`, the JSON lookup the
   tracking page makes for the number in its address. It needs no cookie, token, captcha or
   browser. The reply has the waybill, a progress rail and the scans, newest first, each a line
   of text.
2. `retry`: one more read when the first fails to reach Taxydema or hangs, inside the budget.

- An unknown number is HTTP 404 with the error "Δεν βρέθηκε αποστολή με τα κριτήρια επιλογής
  σας.", which the page reports as not found. The error names no number. A 404 without it, such
  as the server's own page for a route it does not have, is not a missing parcel, and neither
  is a redirect.
- A shipment must name the number asked as its waybill.
- The site refuses some clients' names, such as curl's, with HTTP 403 and `{"error":"Forbidden"}`,
  reported as a challenge. It answers the host's own User-Agent.
- Recognition makes the same request. No detection rule offers Taxydema, so preflight does not
  ask it.

## Notes

- Each scan starts with the station's date and wall clock to the second, without an offset.
  Every station is in Greece, so the clock is read in Athens and kept as an instant. An hour
  repeated when the clocks go back is read at its first occurrence.
- The scans are Greek wording without codes, mapped in [`status.ts`](status.ts). The station
  after the wording is the scan's location. The head office sends the messages to the
  recipient and is no place the parcel is.
- A message to the recipient names the masked phone it went to, then a subject with the sender
  and links to the parcel's delivery options or a survey. The adapter keeps only that a message
  was sent, which moves nothing. A delivery's line names who took the parcel and when; that
  part is dropped. Every line loses links, phone numbers and email addresses.
- The rail's last step, dated once the parcel got there, settles a delivery, or a return when
  the reply marks the parcel as going back to its sender. Otherwise the newest scan with a stage
  decides.
- The page also shows the towns the parcel goes from and to, and an incoming or outgoing waybill
  for a parcel another network handed over or took on. None of these is kept: the towns are the
  recipient's area, and no reply seen carries a waybill that shows which network it belongs to.
- An earlier version of the tracker answered in another format, with other wording. Its
  wording stays in the map.

## Limitations

- No delivery estimate, weight, service or pickup point.
- No delivery partner, even for a parcel Taxydema hands on.

## Numbers

Archived lookups on Taxydema's tracker show twelve-digit numbers beginning with 40, including
parcels Meest International sends to Greece. Twelve digits are shared by many carriers and
nothing in the number points to Taxydema, so no rule claims it. The adapter takes any twelve
digits. The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`www.taxydema.gr/entopismos/{number}` opens one parcel: the tracker page reads the number from
the last path segment and looks it up, and archived lookups on Taxydema's host use that
address.

## Testing

`npm run test:carriers:live -- carriers/taxydema`, with `TAXYDEMA_TRACKING_NUMBER` and
optionally `TAXYDEMA_UNKNOWN_NUMBER` set outside the repository.
