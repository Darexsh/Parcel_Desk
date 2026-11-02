# Bangladesh Post Office

Tracks Bangladesh Post items, its own and the S10 items other posts send to Bangladesh, through
the lookups its two tracking pages make.

## How it works

1. `direct`: one `POST https://ipsbd.bdpost.gov.bd/app_mail_tracking/search1.php` with the form
   field `item_id`, as the international tracker's page sends it. It needs no account, cookie,
   token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.
3. `domestic`: a code ending `BD` that the international tracker does not know goes to the
   domestic tracker. A `GET https://report.dms.bdpost.gov.bd/` reads the token its page carries,
   then `POST https://report.dms.bdpost.gov.bd/mail_tracking_new/get_data.php` sends
   `{"item_id":"{number}","csrf_token":"{token}"}`, as the page's script does. A failed connection
   gets one more try.

- The international reply is a JSON string: the page's history table, or its "item not found"
  in Bengali, which is not found. Its "database error" is inconclusive. The table does not name
  the item, but the tracker matches whole codes only.
- The domestic reply names the item, which must be the whole requested code. Its "no information
  found for the ID" names the code too, and is not found. Its format refusal is invalid input. A
  refused token, its "invalid access" or another refusal is a changed request.
- A 403 or a firewall page is a challenge, a 429 a rate limit, and a 404 or a redirect a moved
  route. Recognition makes the same requests.

## Notes

- An international scan's clock is the recording office's wall clock to the second, with no
  zone. The table does not say where the office is, so the clocks stay `local_time`.
- Domestic scans come from Bangladeshi offices, on a twelve-hour clock. Bangladesh has one zone
  without daylight saving time, so they are read as Dhaka time.
- The domestic tracker lists every booking under the code, oldest first. Its page shows the last
  as the item's, and so does the adapter.
- A rollback undoes the item's scan before it. The page then shows a delivery or return to the
  sender before a later scan of the item as unsuccessful, and the adapter reads it as a failed
  attempt. The rollback itself has no stage. A move of the bag the item travels in undoes
  nothing.
- Domestic offices come with their type and an office code that embeds the postcode. The adapter
  keeps the office's name. Remarks lose phone numbers.
- The international table names the origin country, which the adapter does not keep, and the
  destination, which it maps to a country code.

## Limitations

- Neither tracker gives an ETA, weight, recipient or delivery instant with a zone.
- The domestic tracker answers only Bangladesh Post's own codes; the international one is asked
  first, so a domestic lookup takes three requests.
- The adapter takes only S10 codes with a valid check digit.

## Numbers

Both trackers take UPU S10 numbers: two letters, nine digits and two letters. Bangladesh Post's
own end in `BD`, its domestic items included. Mail from abroad keeps the suffix of the post that
issued it. The adapter takes S10 codes from any post with a valid check digit; anything else is
invalid without a request.

The issuer of an S10 code does not establish who delivers it, so detection keeps codes ending
`BD` with the generic postal carrier. `bangladesh-post-s10`, at low confidence, makes preflight
ask Bangladesh Post about them. Mail from abroad reaches Bangladesh Post when a caller names it, a
provider names it, or a result gives Bangladesh as the destination of an S10 item. The samples and
their sources are in [`numbers.json`](numbers.json).

## Links

The domestic tracker's page reads the number from its `v` or `V` parameter and looks it up when
it opens, so `report.dms.bdpost.gov.bd/?v={number}` is read as a Bangladesh Post link. The
international tracker sends the number in a form post, so no address opens one item there.

## Testing

`npm run test:carriers:live -- carriers/bangladesh-post`, with `BANGLADESH_POST_TRACKING_NUMBER`
set outside the repository to an item the international tracker knows. Optionally set
`BANGLADESH_POST_DOMESTIC_NUMBER` to check the domestic tracker and
`BANGLADESH_POST_UNKNOWN_NUMBER` to check a code neither tracker knows.
