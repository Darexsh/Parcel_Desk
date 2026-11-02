# HayPost

Tracks the Armenian post's items, its own and the S10 items other posts send to Armenia,
through the lookup its tracking page at haypost.am makes.

## How it works

1. `direct`: one `GET https://api.haypost.am/trackingNumber/?trackingNumber=<code>&lng=en`, as
   the page sends it for the code in its address or field, in the page's language. It needs no
   account, cookie, token, key or browser. The page loads an invisible reCAPTCHA for its forms,
   and its own lookup sends no token.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The reply gives `error`, a `message` and the item's scans in `data.result`. It does not echo
  the code, so its scans are those of the code asked for. A code the tracker does not know comes
  back as the error "Not Valid Tracking Number Format" with no scans, whatever the code's shape;
  for a code with a valid check digit that is not found. Any other error, or no error and no
  scans, is not.
- A 429 is a rate limit, a 403 or a bot check a challenge, and a redirect or a 404 a moved route.
  Recognition makes the same request.

## Notes

- The scans are IPS's, the UPU's system, which HayPost and the posts abroad record. Each names
  the event with its leg, "(Otb)" outward, "(Inb)" inward and "(EDI-received)" for a scan the
  sending post reported as data. The leg does not change the stage.
- Each scan gives the scanning office's wall clock, without a zone, twice: as the page shows it
  and in ISO form. A scan in Armenia reads on Yerevan time; a relay that gives the same scans
  with offsets puts HayPost's at +04:00. A scan abroad, or in a country the row does not settle,
  keeps its wall clock.
- IPS names countries in ISO's style, "Netherlands (the)". The adapter drops the article.
- The country of an inward scan becomes the destination.
- A scan's extra information carries the reason an item was not delivered and what happens
  next, which the adapter adds to the event. It drops any other detail, which could name a
  person.
- The reply lists scans oldest first; the adapter lists them newest first, as the page does.
- HayPost's Android app asks another host for the same records. The page's lookup is enough.

## Limitations

- The tracker has no ETA, weight, service or sender.
- Orders created through HayPost's business API carry ids of `PAS`, nine digits and `AM`. The
  tracker does not find the public example, so the adapter does not take them.
- The adapter takes only S10 codes with a valid check digit.
- HayPost's own items sent abroad were not seen live; the adapter reads them from the same IPS
  scans.

## Numbers

HayPost items carry UPU S10 numbers ending in `AM`. The issuer of an S10 code does not establish
who delivers it, so detection keeps such codes with the generic postal carrier. `haypost-s10`, at
low confidence, makes preflight ask HayPost about them. Mail from abroad keeps the suffix of the
post that issued it, and reaches HayPost when a caller names it, a provider names it, or a result
gives Armenia as the destination of an S10 item. Orders created through HayPost's business API
carry ids of `PAS`, nine digits and `AM`; one public example is too little for a rule. The
samples and their sources are in [`numbers.json`](numbers.json).

## Links

haypost.am's tracking page reads the number from the address fragment after
`/am/track-trace#`, which its own search form writes, and looks it up. An address without the
language redirects to one with it and drops the fragment, and the English page shows a first
visitor its labels' keys, so the link opens the Armenian page. Detection cannot read a fragment,
so there is no link rule.

## Testing

`npm run test:carriers:live -- carriers/haypost`, with `HAYPOST_TRACKING_NUMBER` set outside the
repository. Optionally set `HAYPOST_INBOUND_NUMBER` to check mail from abroad delivered in
Armenia and `HAYPOST_UNKNOWN_NUMBER` to check a code the tracker does not know.
