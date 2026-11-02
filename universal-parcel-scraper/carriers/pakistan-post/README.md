# Pakistan Post

Tracks Pakistan Post's domestic articles and international items, its own and those other posts
send to Pakistan, through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://ep.gov.pk/emtts/EPTrack_Live.aspx?ArticleIDz={number}`. The
   tracking form on ep.gov.pk posts the number to `track.asp`, which opens this page for it in a
   frame. It needs no account, cookie, token, captcha or browser. The page is rendered on the
   server.
2. `retry`: a lookup that fails to reach the tracker, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- A page whose history is the tracker's `Route Not Found`, its answer for a domestic number, is
  not found. An S10 code the tracker holds nothing for comes back with empty histories and no
  notice, which is inconclusive, as is an empty page. A 403, a firewall page or a bot check is a
  challenge. A 404 or a redirect is a moved route.
- The page must echo the whole requested number. Recognition makes the same request.

## Notes

- A scan's date and time are the scanning office's wall clock to the minute, with no zone. An
  international history mixes Pakistan's clocks with the other post's, so the clocks stay
  `local_time`.
- International scans carry the UPU's IPS event names. Their `in origin country` or `in
  destination country` leg is not reliable: the tracker gives Pakistani scans of items from
  abroad the origin's leg too. The adapter stages them by the event and keeps the wording.
- Domestic scans name the offices in their wording. The page adds the bag a scan moved in, the
  person who took a delivered item, and reasons for a failed attempt or a return that can be free
  text. The adapter drops the bag and the person, keeps the reasons the delivery staff's list
  gives and drops the rest, and drops phone numbers from any scan.
- An international item's destination country is kept. The summary's origin, the booking and
  delivery offices of a domestic article, and the money order a cash-on-delivery or value-payable
  item's page appends, under its own number, are not.
- The page lists some scans twice; the adapter keeps them once.
- Pakistan Post's Android app (`com.a360technologies.adeelnasir.emtts`) asks a SOAP service for
  the same history: `TrackArticle` on
  `https://emtts.dakkhana.com.pk/MobileAppSOAP/EPTrackLive.asmx`, with no account. The adapter
  uses the web page, which the site's own form opens.

## Limitations

- The page has no ETA, weight, service or delivery instant with a zone.
- Older domestic articles drop out of the tracker's records and then read as not found.

## Numbers

International items carry UPU S10 numbers ending in `PK`. Items from abroad keep the number of
the post that accepted them. The adapter takes S10 codes from any post with a valid check digit,
and domestic article numbers of three letters for the service, such as `RGL`, `UMS` or `PAR`, and
eight digits. Anything else is invalid without a request.

S10 numbers stay with generic postal detection: the issuer of an S10 code does not establish who
delivers it. A code ending `PK` only suggests Pakistan Post, which recognition asks first. An S10
item from abroad bound for Pakistan is handed to Pakistan Post under the sending post's number. Domestic registered letters and parcels quoted by customers are `RGL` or `PAR`
followed by eight digits; a low-confidence rule makes preflight ask Pakistan Post about them.
The samples and their sources are in [`numbers.json`](numbers.json).

## Links

`ep.gov.pk/emtts/EPTrack_Live.aspx?ArticleIDz={number}` opens one item, and the library reads
the number from that address.

## Testing

`npm run test:carriers:live -- carriers/pakistan-post`, with `PAKISTAN_POST_TRACKING_NUMBER` set
outside the repository. Optionally set `PAKISTAN_POST_DOMESTIC_NUMBER` to check a domestic
article and `PAKISTAN_POST_UNKNOWN_NUMBER` to check a number the tracker does not know.
