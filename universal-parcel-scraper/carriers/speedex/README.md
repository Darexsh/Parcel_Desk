# Speedex

Speedex is a Greek courier with its own branches across the country. It also delivers parcels
DHL hands over in Greece. Tracked through the page its tracking search frames.

## How it works

1. `direct`: one `GET https://www.speedex.gr/speedex/NewTrackAndTrace.aspx?number={number}`.
   It needs no cookie, key, captcha or browser, and the server-rendered page has the scans,
   oldest first.
2. `retry`: one more read when the first fails to reach Speedex or hangs, inside the budget.

- An unknown number is HTTP 200 with the notice "Δεν βρέθηκαν αποτελέσματα.", which the page
  reports as not found. A 404 or a redirect is a moved route.
- The page must echo the number asked in its search field.
- Recognition makes the same request. No detection rule offers Speedex, so preflight does not
  ask it.

## Notes

- Each scan's clock, `dd/mm/yyyy στις HH:mm`, is the branch's wall clock to the minute, with no
  zone, so it stays `local_time`.
- A scan names a branch's street address, phone and map link, or a sorting centre. Only the
  branch's name after the address is kept.
- A delivered parcel gets a card under the scans, `Η ΑΠΟΣΤΟΛΗ ΠΑΡΑΔΟΘΗΚΕ`, which settles the
  delivery. Its line naming who took the parcel is not kept.
- The page's view state repeats the history with the recipient's name. The adapter does not
  read it.
- The scans are Greek wording without codes, mapped in [`status.ts`](status.ts). Messages to
  the recipient, a cancelled shop scan and a customer's instruction to collect at the branch
  move nothing.
- The page writes `ΑΠΟ` with and without its accent; both map alike.

## Limitations

- No delivery estimate, weight, service, sender or offsets.
- Old vouchers come back as not found.

## Numbers

Speedex vouchers are twelve digits. Lookups archived from Speedex's tracker show them starting
`01`, `04`, `05` and `70`. Twelve digits are shared with several carriers,
Courier Center among them, so no rule claims them. The tracker also answers DHL parcel numbers
(`JJD` and eighteen digits) that Speedex delivers in Greece; detection leaves those with DHL.
The samples and their sources are in [`numbers.json`](numbers.json).

## Links

Speedex's search form sends the number as `voucher_code` to `www.speedex.gr/isapohi.asp`, which
frames `www.speedex.gr/speedex/NewTrackAndTrace.aspx?number={number}` with the history. Both
addresses open one parcel.

## Browser recovery

When the direct lookup returns a bot check, configured TRAWL opens the same parcel page and
uses the same parser. Rate limits, definite answers and changed pages do not start a browser.
Recognition stays on direct HTTP. Set `FLARESOLVERR_URL` to enable recovery in the live tracking check.

## Testing

`npm run test:carriers:live -- carriers/speedex`, with `SPEEDEX_TRACKING_NUMBER` and optionally
`SPEEDEX_UNKNOWN_NUMBER` set outside the repository.
