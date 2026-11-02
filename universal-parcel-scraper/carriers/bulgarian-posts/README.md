# Bulgarian Posts

Tracks Bulgarian Posts items, its own and the S10 items of other posts, through the lookup its
tracking page makes.

## How it works

1. `direct`: one `GET https://www.bgpost.bg/api/trace/parcel/{number}?language=EN`, as the
   English tracking page sends it. It needs no account, cookie, token, key or browser.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- The reply's `parcels` holds the scans, oldest first. It does not name the item: the path holds
  the whole code, and the tracker matches only whole codes. An empty list is the page's empty
  table, which is not found. A code the tracker cannot read gets one row, `Грешен код на
  пратката` on an empty date, which is invalid input. When `bulpost.is_bulpost` is set the page
  shows the item on Bulpost's own page instead, which the adapter reads as inconclusive.
- A 429 is a rate limit. A 403 or a firewall page is a challenge. A 404 or a redirect is a moved
  route. Recognition makes the same request.

## Notes

- International scans carry the UPU's IPS event names in English, mostly with their leg: `(Otb)`
  in the posting country, `(Inb)` in Bulgaria. Bulgarian Posts' domestic scans stay in Bulgarian
  whatever language the page asks for. The event and status codes are always zero, so the event
  name sets the stage, and unknown wording goes to the shared rules.
- The page shows a detail beside some scans, such as the status customs recorded. The
  description adds it after a colon. The reply's `note`, which the page does not show, is not
  kept.
- A scan's `date_reg` is the scanning office's wall clock to the minute, with no zone. The former
  IPS Web tracker headed that column "Local Date and Time", and the page shows the sending post's
  scans at that post's own clock. Bulgarian offices' clocks follow Sofia's daylight saving time:
  a summer delivery scanned just before an office closes would fall after closing on a fixed
  winter offset. They are read as Sofia time, a repeated autumn hour by its first occurrence; a
  spring hour Sofia skips stays `local_time`. The sending post's scans stay `local_time`.
- `office_name` is the country, a comma and the office. Domestic scans write the country in
  Bulgarian and put the office's postcode before its town. The English reply leaves the country
  of Bulgarian post offices blank, which the Bulgarian reply fills in, so a blank country counts
  as Bulgaria only for `PS` and a postcode, or an office named in Cyrillic.
- Postcodes are dropped: a post office named only by its postcode becomes `Bulgaria`, and a
  foreign office whose name has a digit keeps only its country.

## Limitations

- The page follows an item posted in Bulgaria until the office of exchange sends it abroad.
  Mail from abroad shows the sending post's acceptance and despatch, then Bulgarian scans from
  its arrival.
- Older items drop out of the tracker's records and then read as not found.
- Items the page hands to Bulpost, the EMS courier, are inconclusive.
- The tracker has no ETA, weight, service, origin, destination or recipient.

## Numbers

International items carry UPU S10 numbers, which generic postal detection handles; the country
code at the end names the post that issued them. Bulgarian Posts' tracking page says e-packages
and domestic items carry thirteen letters and digits starting `PS`, which `bulgarian-posts-1`
claims. The adapter takes S10 codes from any post with a valid check digit and `PS` numbers;
anything else is invalid without a request.

A code ending `BG` is Bulgarian Posts', but the issuer of an S10 code does not establish who
delivers it, so detection keeps such codes with the generic postal carrier. `bulgarian-posts-s10`,
at low confidence, makes preflight ask Bulgarian Posts about them. Mail from abroad keeps the
suffix of the post that issued it, and reaches Bulgarian Posts when a caller names it, a provider
names it, or a result gives Bulgaria as the destination of an S10 item. The samples and their
sources are in [`numbers.json`](numbers.json).

## Links

The tracking page reads the number from `itemid` on `bgpost.bg/postal-services/track-package`
and its English twin, so that address opens one item. The former IPS Web tracker took the same
parameter on `bgpost.bg/IPSWebTracking/IPSWeb_item_events.asp`.

## Testing

`npm run test:carriers:live -- carriers/bulgarian-posts`, with `BULGARIAN_POSTS_TRACKING_NUMBER`
set outside the repository. Optionally set `BULGARIAN_POSTS_INBOUND_NUMBER` to check mail from
abroad, `BULGARIAN_POSTS_OUTBOUND_NUMBER` to check an item posted in Bulgaria and
`BULGARIAN_POSTS_UNKNOWN_NUMBER` to check a code the tracker does not know.
