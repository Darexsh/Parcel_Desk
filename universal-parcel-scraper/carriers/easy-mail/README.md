# Easy Mail

Easy Mail is a Greek courier with its own stores and sorting centres across the country.
Tracked through the tracker page Easy Mail's website opens for a voucher.

## How it works

1. `direct`: one `GET https://trackntrace.easymail.gr/{voucher}`. The tracking box on
   easymail.gr posts the voucher to its web-tracking page, which frames this address. It needs no
   cookie, token, captcha or browser, and the server-rendered page has the current status and every
   scan, newest first.
2. `retry`: one more read when the first fails to reach Easy Mail or hangs, inside the budget.

- An unknown voucher is HTTP 200 with the notice "Δεν βρέθηκε η Αποστολή", which does not name
  the voucher. Another notice is inconclusive. A 404 or a redirect is a moved route.
- Every row names its voucher, and each must be the one asked.
- The tracker's own search form posts the voucher behind a reCAPTCHA, so the adapter opens the
  address the website frames instead. Every tracker page loads Google's reCAPTCHA script for that
  form, so the script alone is no block.
- No recognition: no detection rule offers Easy Mail, so preflight never asks it.

## Notes

- Each scan's clock is the store's wall clock to the second, read in Athens and kept as an
  instant. An hour repeated when the clocks go back is read at its first occurrence.
- The scans are Greek wording without codes, mapped in [`status.ts`](status.ts). Older scans
  spell "arrived" Αφίχθει and newer ones Αφίχθη, and both map alike. A parcel the sender brings
  to a store is accepted on its arrival there. A non-delivery reason is a failed attempt, except
  collection at the store, which leaves the parcel waiting there.
- The current status over the scans repeats the newest scan and is only checked for its voucher.
- The delivery's masked recipient and the store's phone and address are not kept. Older lookups
  name SPEEDEX as a store for the last leg; it names no place, so that scan has no location.
- The partner voucher column was empty in every lookup seen, and is not read.

## Limitations

- No delivery estimate, weight, service, sender or pickup point.

## Numbers

Easy Mail vouchers are eleven digits, and the tracker prints them with a leading zero as twelve
digits. The adapter takes either form and asks for the eleven digits. Archived lookups on Easy
Mail's tracker and web-tracking page show them. No rule claims them: Courier Center and other
carriers print numbers of the same lengths, so the shape alone cannot name Easy Mail. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

The tracker opens one parcel at its address followed by the voucher. Older links to the
website's web-tracking page pass the voucher as `tracking_number`; the page now frames an address
the tracker refuses for them. Both are read as links.

## Testing

`npm run test:carriers:live -- carriers/easy-mail`, with `EASY_MAIL_TRACKING_NUMBER` and
optionally `EASY_MAIL_UNKNOWN_NUMBER` set outside the repository.
