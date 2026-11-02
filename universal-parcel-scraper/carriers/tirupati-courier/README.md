# Shree Tirupati Courier

Shree Tirupati Courier Services is a domestic courier network in India. Tracked through the
lookup its website's tracking box makes.

## How it works

1. `direct`: three requests to `https://www.shreetirupaticourier.net`, as the tracking box in
   every page's header makes them. They need no cookie, captcha, account or browser.
   - `GET /TopHeader.aspx` returns the box: a WebForms form and its state.
   - A `POST` of that state to the same page, with the number in `trackingno` and `btnTrack=Go`,
     is what the box's Go button sends. It answers with a redirect to
     `/Frm_DocList.aspx?docnos={key}`, where the key is the number the server encrypted.
   - `GET /Frm_DocTrackWeb.aspx?docno={key}` returns the tracking detail that list opens in its
     frame: the booking, the jobs and a status line.
2. `retry`: a request that fails to reach the site, or hangs, is sent once more within the
   budget. The first try gets half of it.

- The redirect writes the key as raw Base64. The adapter encodes it, so a `+` does not reach the
  server as a space.
- The key opens the parcel's page, so errors leave out the request details that carry it.
- A number without a booking gets the same detail with the number echoed and every field empty,
  which is not found.
- The site sends a request it fails to `/_NotAvailable.aspx`, worded as scheduled maintenance.
  That redirect is inconclusive, not a missing parcel. Any other redirect or a 404 is a moved
  route, and a post answered with the box again is a broken reply. A 403 or a page without its
  fields that carries a bot check is a challenge.
- The detail must echo the number asked.
- Recognition makes the same requests. No detection rule offers Shree Tirupati Courier, so
  recognition is not asked until one does.

## Notes

- Every branch and office is in India, which keeps UTC+5:30 all year, so clocks are read in
  `Asia/Kolkata`. The booking's day and minute, as `29-08-26 - 07:00 PM`, become an instant.
  The jobs and the status line give only a day, which stays a local date.
- A job is `OUT` from the office its route names first to the next one, or `IN` at the office
  that received it. The adapter words them as the status line does, `Out To …` and
  `Received At …`, at the office named first. Both are in transit. A job of another kind keeps
  only its code, since its route could name a person.
- The status line, as `Received At … On Dated 03-08-26` or `Delivered On Dated 12-09-26 By …`,
  repeats the newest job and is kept once. A delivery appears only there, with its day and the
  delivering office.
- A delivered consignment's page hides its jobs and keeps only the booking and the status line,
  so its history is marked truncated.
- The consignee, the destination, the offices' addresses and phone numbers in the names'
  tooltips, and the phone numbers under the status line are not kept.

## Limitations

- No scan clocks, expected delivery, weight, service, sender or proof of delivery.
- The tracking box takes several numbers separated by commas; the adapter sends one.

## Numbers

The tracking box asks for twelve-digit AWB numbers, and the adapter takes only those. Lookups
archived from the carrier's tracker show twelve-digit numbers, and lookups archived from its
older tracker show ten-digit docket numbers, which the current tracker answers as unknown.
Digit runs of these lengths are printed by many other carriers, so no rule claims them and
preflight does not ask Shree Tirupati Courier: a number reaches the adapter when the user, a
link or a provider names the carrier. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The current tracker opens a result page whose address carries the server's key instead of the
number, so no address opens one parcel. Lookups archived from the older tracker pages carry the
number as `docno` on `Frm_DocTrack.aspx` and `frmtracking.aspx`; the number is read from them.

## Testing

`npm run test:carriers:live -- carriers/tirupati-courier`, with
`TIRUPATI_COURIER_TRACKING_NUMBER` and optionally `TIRUPATI_COURIER_UNKNOWN_NUMBER` set outside
the repository.
