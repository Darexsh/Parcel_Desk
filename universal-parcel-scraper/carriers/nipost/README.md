# NIPOST

Tracks NIPOST items, its own and the S10 items of other posts, through the lookup its tracking
page makes.

## How it works

1. `direct`: one `POST https://tracking.nipost.gov.ng/{number}` with the header
   `Next-Action: {id}` and the body `["{number}"]`, as the page calls its server action when it
   opens. It needs no account, cookie, token, key or browser.
2. `action`: when the tracker no longer has the id, it answers with its page (HTTP 200), or
   with Next's 404 for an unknown action. The adapter then reads the page, its route chunk and
   the shared chunks that route loads, six at most and each with a size limit, takes the id bound
   to the page's lookup, and asks once more with it. A page that binds no new id is a changed
   lookup, a schema error, never a missing item. A read id is tried first for six hours after it
   last answered.
3. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try, and the `action` step, get half of what is left.

- The reply is a React Server Components stream whose row 0 names the row holding the action's
  `{ data, error }` result. `data` lists the items the code names, each with its scans. An unknown
  code is `data: null` with the error "Tracking number not found", which is not found. Another
  error, a result without items or an item without scans is inconclusive; one that mentions too
  many requests is a rate limit. An error row in place of the result is inconclusive, and a Next
  redirect there is a moved route. A 403 or a firewall page is a challenge, a 429 a rate limit, and
  a redirect, a 405 or a 410 a moved route.
- The item must name the whole requested code, as `tracking_number` or `code`. Recognition makes
  the same request.

## Notes

- Every visitor's page carries the same action id. Next 14 derives it from the action's module
  and name; later versions change it with each build. The page awaits the action's reference and
  reads `data` and `error` from what it returns; the reference's module builds it from the id
  with `createServerReference`. Only an id bound that way is taken: the other ids the module
  registers belong to other actions.
- Each scan has a status key, a description, a location and a clock. The page labels scans with
  the keys its code knows, which the map follows; `PENDING`, the first, is left to the wording.
  An unknown key goes to the shared wording rules, and the key is kept.
- A clock with an offset, or a Date, is an instant. A clock without one stays `local_time`: the
  tracker relays scans of Nigerian offices and of the posts that send mail to Nigeria alike, so
  no zone is assigned. A delivery date counts only with an offset.
- The page's customs payment notice links to a payment page for the item; the adapter reads
  neither the payment details nor the link, nor the origin.

## Limitations

- The tracker has no ETA, weight, service, recipient, sender or proof of delivery.
- The shape of a found item comes from the fields the page's code reads; replies are checked
  strictly, so a changed field reads as a schema error rather than as missing.
- The adapter takes only S10 codes with a valid check digit. The tracker's help says domestic
  numbers may run to sixteen characters; no such number has been seen.

## Numbers

NIPOST prints UPU S10 numbers ending in `NG`, which customers quote for EMS and registered
items. The adapter takes S10 codes from any post with a valid check digit; anything else is
invalid without a request. A comma would ask the tracker for several items at once, so none is
sent.

A code ending `NG` is NIPOST's, but the issuer of an S10 code does not establish who delivers
it, so detection keeps such codes with the generic postal carrier. `nipost-s10`, at low
confidence, makes preflight ask NIPOST about them. Mail from abroad keeps the suffix of the post
that issued it, and reaches NIPOST when a caller or provider names it; destination hand-off waits
for a tracked inbound item. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracking form sends the number as the path, so `tracking.nipost.gov.ng/{number}` opens one
parcel. Several numbers can be given at once, separated by commas.

## Testing

`npm run test:carriers:live -- carriers/nipost`, with `NIPOST_TRACKING_NUMBER` set outside the
repository. Optionally set `NIPOST_UNKNOWN_NUMBER` to a code the tracker does not know: it is
read as not found, the page must bind the built-in action id, and the `action` step must read it
from the page after an id the tracker does not have.
