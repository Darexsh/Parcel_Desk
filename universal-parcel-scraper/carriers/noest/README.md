# NOEST Express

NOEST Express is an Algerian courier founded in 2018. It collects from merchants and delivers
across most of Algeria, to homes or to its stop-desk offices, with cash on delivery. Tracked
through the form of its public tracking page, which runs on the ECOTRACK platform.

## How it works

1. `direct`: `GET https://app.noest-dz.com/list/t` for the form's `_token` and the
   `noest_express_session` cookie it belongs to, then a `POST` to the same address with the
   token, `tracking` set to the one number, and the cookie. No account, key or browser is
   needed. Without the page's session Laravel answers HTTP 419, which is inconclusive.
2. `retry`: when NOEST cannot be reached or hangs, the lookup starts again with a new page
   once. The first try gets half of the budget.

- The answer is the form again, showing the numbers it was given, and above it a box for each
  number NOEST holds, headed with the number and listing its events oldest first. Only the box
  headed with the whole number asked is read.
- A number NOEST does not hold gets no box. That is not found only when the form shows the
  number asked back.
- A redirect, a 404 or a 410 means the page moved; a 403 or a bot check is a challenge.
- Recognition makes the same requests.

## Notes

- The form takes several numbers, one per line; the adapter sends one.
- The tracker finds a number only as printed, in capitals with its hyphens: without them it
  shows nothing, and in lower case a box without events. Normalized numbers lose the hyphens,
  so the adapter puts them back.
- `GET /list/t/{number}` shows the same box without a session, but answers an unknown number
  with the empty form, which does not show the number. The form's own answer does, so the
  adapter posts the form.
- Event clocks have no zone and are read as Algerian time, UTC+1 all year: NOEST works only in
  Algeria, and the public sample's first event matches its merchant's own UTC record of the
  order at that offset.
- The tracker shows wordings without codes. The map follows NOEST's merchant API
  documentation, which lists them with their keys. Payouts of the cash collected, edits and
  other bookkeeping events move nothing and get no stage. "Commande supprimée" is an order the
  merchant deleted, an exception.
- `delivered_at` is the "Livré" event.
- The note the page can show under an event, and the column saying who acted, the merchant or
  NOEST, are not kept.
- NOEST's merchant API reads parcels with each merchant's token, so the adapter does not use it.

## Limitations

- No place, estimate, weight, recipient, stop-desk office or proof of delivery.

## Numbers

The one public NOEST tracking number found is three letters, three letters or digits and eight
digits, joined by hyphens. No rule claims that layout until more numbers confirm it, so
recognition never asks NOEST and a lookup reaches it when the carrier is chosen. The adapter
takes that layout with or without the hyphens.

## Links

`app.noest-dz.com/list/t/{number}` opens the tracker with one number's box, and so does
`/tracking/{number}`; both need the number in capitals with its hyphens. Links use the first
and put the hyphens back.

## Testing

`npm run test:carriers:live -- carriers/noest`, with `NOEST_TRACKING_NUMBER` and optionally
`NOEST_UNKNOWN_NUMBER` set outside the repository.
