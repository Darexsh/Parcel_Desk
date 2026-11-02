# Foxpost

The Hungarian parcel-locker network. Tracked through its public tracking page.

## How it works

1. `direct`: one `GET https://foxpost.hu/csomagkovetes/?code={number}`. The page is rendered on
   the server; it needs no cookies, token, account or browser.
2. `retry`: one more try when the request fails to reach Foxpost or hangs. The first try gets
   half of the budget.

- The page names the parcel it shows; it must be the requested number, otherwise
  `SchemaError`.
- A number Foxpost does not know returns the form again with its "not found" notice:
  `NotFoundError`. Any other notice, or a page without the form, is inconclusive.
- The tracker also takes Packeta's `Z` numbers. One it handles returns its history; one it does
  not know is redirected to Packeta's tracker, which is `NotFoundError` with the reason
  `packeta_number`. Any other redirect is inconclusive.
- Recognition makes the same request; the not-found notice is the only unknown answer.

## Notes

- Each scan has a short title and a sentence. The titles group statuses: "Automatában" is
  both a parcel the sender dropped in a locker and one waiting in the recipient's, and
  "Raktárban" covers a return as well as a parcel on its way. Stages come from the sentences,
  which are the long texts of Foxpost's API statuses. A link after a sentence is not kept.
- The page renders a scan's Budapest clock at view time, moved by Budapest's offset then less
  its offset at the scan. A scan in the season the page is viewed in shows Budapest's clock,
  and a winter scan viewed in summer an hour earlier: a `CLFOX` ID carries the second the parcel
  was created, which its first scan shows so. Those scans are dated, and a delivery sets
  `delivered_at` and recognition's last activity. A summer scan viewed in winter, which no page
  has shown, and a scan within hours of a clock change keep a wall clock.
- The sender's name is kept as `sender_name`. The delivery method is kept as the pickup point
  only when it links to a Foxpost locker or point page, and not once the parcel is returned or
  was delivered to the door. The order number and payment details are not read; recipient
  details are not on the page.

## Numbers

Foxpost's tracker asks for the parcel ID from the shipping email. Its pages say that locker and
pickup-point parcels carry an ID starting `CLFOX` or `Z` and home deliveries a number starting
`66639`. The adapter takes `CLFOX` and fifteen digits, which `foxpost-1` claims, `Z` and ten
digits, ten digits starting `66`, which the tracker answers for locker parcels too, and `66639`
with five to fifteen more digits. `Z` and ten digits is the layout of Packeta, which is merging
its Hungarian lockers into Foxpost, and stays with Packeta's rule.

No source gives the length of a home-delivery number, and Foxpost's API caps a parcel's barcode
at twenty characters, so `foxpost-home-delivery` suggests Foxpost first for `66639` and five to
fifteen digits. Other carriers print such digits too, so the rule is low and recognition asks
Foxpost. No rule claims the other `66` numbers.

## Links

Foxpost's tracking form sends the number as `code` to `foxpost.hu/csomagkovetes/`, so
`foxpost.hu/csomagkovetes/?code={number}` opens one parcel. Archived lookups also use the
English page, `foxpost.hu/en/parcel-tracking?code={number}`, which shows the same Hungarian
page.

## Limitations

- No delivery estimate, scan location or weight.
- No source gives the sentences of eight statuses of Foxpost's API; a scan with one keeps no stage.
- The length of home-delivery numbers is unconfirmed.

## Testing

`FOXPOST_TRACKING_NUMBER=... FOXPOST_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/foxpost`
