# Fukuyama Transporting

Fukuyama Transporting (福山通運) is a Japanese carrier of parcels and freight, which it collects
and delivers from its own branches across Japan. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://seikyu.fukuyama-tsuun.com/corp/tracking_no_hunt/{number}`, the
   page the tracking form on the home page opens. The site renders it on its server: a summary
   with the number, the parcel count, the weight and the current state, then one row per
   milestone with its day, its branch and the branch's phone number. It needs no cookie, token,
   key or browser.
2. `retry`: one more request after a network failure or a timeout.

- The page is read in the charset its Content-Type or its meta tag declares. The tracker
  declares Shift_JIS.
- The summary prints the number in groups, padding a ten-digit number with a leading zero, and
  it must be the number asked.
- An unknown number is HTTP 200 with "該当データはありません。" as the lookup's result beside the
  number. Only that answer, for the number asked, is not found.
- A number the tracking form does not take comes back as the search form, with its warning and
  the number still in the field. That is an invalid number.
- A browser check or a firewall refusal, with HTTP 200 or 403, is a challenge. A redirect or a
  404 is a moved page.
- Recognition makes the same request.

## Notes

- The history has a fixed row for each milestone, from the intake at the sending branch to the
  delivery. A milestone not reached yet has no day and is left out.
- Every branch is in Japan and prints its wall clock to the minute, so a row's time is an
  instant in Asia/Tokyo. The dispatch row has a day and no time, so it keeps its day in
  `local_time`.
- The summary's state is the carrier's current one and decides the stage. The newest milestone
  decides only a state the map does not know. The tracker has no codes; [`status.ts`](status.ts)
  stages the milestones and the states by their wording.
- The parcel count, the branches' phone numbers and addresses, the delivery day line and the
  links to the waybill images are not kept. The delivery time comes from the delivery row.
- Numbers come round again: an archived lookup and the tracker's answer today for the same
  number can be different parcels.
- Fukuyama's app tracks through `POST https://corp.fukutsu.co.jp/sp_state/state` with the
  number as `genno`, which needs no account. Its JSON reply has the milestones but does not echo
  the number, so the adapter reads the page, which does.
- The former `/situation/tracking_no_hunt/{number}` page still answers, with an older layout.

## Limitations

- No delivery estimate.
- Preflight does not ask Fukuyama about a number, because no detection rule offers it (see
  Numbers). A number filed under Fukuyama is tracked directly.

## Numbers

The tracking number (お問い合わせ番号) has ten or eleven digits. In the eleven-digit numbers the
last digit is the rest modulo 7, the same check as Japan Post's registered numbers, so neither
length tells Fukuyama apart and no rule claims them. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

`seikyu.fukuyama-tsuun.com/corp/tracking_no_hunt/{number}` opens one parcel, and so do links to
the former `corp.fukutsu.co.jp/corp/recieve/tracking_no_hunt/{number}` and
`corp.fukutsu.co.jp/situation/tracking_no_hunt/{number}`, which redirect there.

## Testing

`npm run test:carriers:live -- carriers/fukuyama`, with `FUKUYAMA_TRACKING_NUMBER` and optionally
`FUKUYAMA_UNKNOWN_NUMBER` set outside the repository.
