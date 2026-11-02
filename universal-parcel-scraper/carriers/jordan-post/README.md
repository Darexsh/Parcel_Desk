# Jordan Post

Tracks Jordan Post items, its own and the S10 items other posts send to Jordan, through the
lookup its tracking page makes. Jordan Post's website embeds that page's form from a server it
reaches by IP address.

## How it works

1. `direct`: one `GET https://212.35.69.85/webtracking/IPSWeb_item_events.aspx?itemid={number}&Submit=Submit`,
   the UPU IPS Web Tracking page the form sends an item to when the IPS system holds it. A
   heading names the item, which must be the whole requested code, and a table lists its scans.
   When the page has no information for the code, the adapter asks the form itself: a `GET` of
   `https://212.35.69.84/NewWebTrack/WebTrack_Submit.aspx`, then a `POST` of the form's view
   state with the item option and the code, as its search button sends them. The form also looks
   in Jordan Post's domestic records and lists what it finds in its own table, whose rows must
   name the code.
2. `retry`: a lookup that fails to reach Jordan Post, or hangs, is sent once more within the
   budget. The first try gets half of the budget.

- None of the requests needs a cookie, a token, a key or a browser. The certificate names both
  addresses, so TLS is checked as usual.
- A code neither system holds gets the form back without a table, which is not found. The form
  redirects a code the IPS system holds to the IPS page; after that page said nothing, such a
  redirect is inconclusive.
- A firewall or bot-check page, even with HTTP 200, is a challenge, a 429 a rate limit and a 503
  maintenance. A 404, a 410, another redirect or a changed page is a moved route or a schema
  error. Recognition makes the same requests.
- An item the IPS page knows costs one request; an unknown code costs three.

## Notes

- The page heads its clocks "Local Date and Time", to the second. A Jordanian office's scan is
  read on Amman's clock, a repeated autumn hour by its first occurrence. A scan abroad, such as
  the sending post's despatch, keeps its wall clock as `local_time`.
- Event names are the IPS system's, mostly with their leg: `(Otb)` in the posting country,
  `(Inb)` in the destination and `(EDI-received)` for a scan the sending post reported as data.
  The adapter maps the names without their leg. An inward scan gives the destination country.
- The extra information's reason, measure and retention reason follow the event name after a
  colon. The signatory, the next office, the mail category and office postcodes are dropped.

## Limitations

- No ETA, weight, service or proof of delivery.
- No item from the domestic records has been seen, so the reading of the form's table follows
  the columns its view state names after a search.
- The form also searches by phone number, which the adapter does not use.
- Jordan Post's MyJoBox app looks items up through `/SMS-Jopost/JopostIntegrationController/TrackItemXML/{number}`
  on its own server, which refuses requests without the app's authorization.
- Jordan Post's website is behind a bot check, but its tracking page only embeds the form above.

## Numbers

Jordan Post prints UPU S10 numbers ending in `JO`. The adapter takes S10 codes from any post
with a valid check digit; anything else is invalid without a request.

A code ending `JO` is Jordan Post's, but the issuer of an S10 code does not establish who
delivers it, so detection keeps such codes with the generic postal carrier. `jordan-post-s10`,
at low confidence, makes preflight ask Jordan Post about them. Mail from abroad keeps the suffix
of the post that issued it, and reaches Jordan Post when a caller names it, a provider names it,
or a result gives Jordan as the destination of an S10 item. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The library reads the number from the IPS page's `itemid`, and from the former result page,
`/JordanWebTrack/Result.aspx?itemid={number}` on the form's server, which now fails for every
code.

## Testing

`npm run test:carriers:live -- carriers/jordan-post`, with `JORDAN_POST_TRACKING_NUMBER` set
outside the repository to an item the tracker knows. Optionally set `JORDAN_POST_INBOUND_NUMBER`
to check mail from abroad and `JORDAN_POST_UNKNOWN_NUMBER` to check a code the tracker does not
know.
