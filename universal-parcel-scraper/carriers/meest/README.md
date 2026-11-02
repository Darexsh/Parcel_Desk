# Meest

Tracks parcels on Meest's network, from its consolidation warehouses and partners abroad to
delivery in Ukraine and other countries, through the public tracker Meest's sites frame.

## How it works

Meest's Ukrainian site frames `https://t.meest-group.com/n/<number>`. That page's script posts
an empty form to `https://t.meest-group.com/get.php?what=tracking&test&number=<number>&lang=uk&ext_track=&chk=<check>`,
where the check is the MD5 of a salt written in the page's script, the number and the salt
again. The salt is the same for every visitor and changes from day to day; the lookup answers a
stale or missing check with an empty HTTP 400. The adapter loads the page for the salt, keeps it
for an hour and sends the page's request once per lookup. Without the page's `test` flag the
same rows come with older wording. A 400 for a kept salt sends the `refresh` step, which loads
the page and asks once more; a 400 for a fresh salt is a transport failure. No account, cookie,
CAPTCHA or browser is needed.

The XML reply has a result code and a table of every row that names the number as Meest's own,
the sender's, the label's or a partner's reference. A code other than `000` is inconclusive and
an empty table is not found. Every row must name the requested number. A number found only as a
partner's reference, such as the one a final-mile locker network gave the parcel, brings that
parcel's rows under its own number and is inconclusive. Block pages, HTTP errors and malformed
replies keep their own failure kinds. Recognition uses the same lookup.

## Numbers

Meest's consolidation numbers are two letters, seven digits, two letters, five digits and a
final `G`. No other carrier's rule claims that shape, so a low-confidence rule routes it here.
The tracker also knows the S10 numbers other posts and senders give the parcels Meest carries,
which stay with the postal routing, and partners' references of many shapes. The adapter takes
six to forty letters and digits with at least one digit; anything else is invalid without a
request.

## Notes

Meest's American site frames `tracking-iframe.meest.com` instead, whose JSON reply merges and
drops scans, shifts the days given without a time and words its "not found" by language. It is
not used. The page's second request, keyed by an internal id, returns the pickup branch and the
recipient's details; the adapter does not send it.

Rows carry their wording in Ukrainian, English and Russian. The adapter reads the English,
then the Ukrainian, and the English city and country as the place. It never reads the detail
messages, branch details or status notes. The page hides delivery attempts of code 1628 and the
Chinese consolidator's own registration; the adapter drops them too, and keeps once a scan two
feeds report. Codes come from Meest Post's client API documentation and the tracker.

Clocks carry no offset and are kept as local times, as the page shows them. The American
frame reads every clock as Kyiv time, but a partner feed's rows repeat the clocks its partner's
API gives in UTC, so no one offset fits. A clock of `00:00:00` or `00:00:01` is a day without a
time, as the page shows it. The destination country comes from the rows when
they agree. A partner feed's "To be delivered to" or "Delivery by … with barcode" note gives the
delivery carrier once the catalog can place it, with that carrier's number.

## Limitations

Meest drops old histories, after which a number answers as not found. The reply has no
estimated delivery date. A hyphenated sender number is sent without its dash.

## Links

The link opens the tracker's page for the number. Pasted links to it, to the `parcel-track`
pages of Meest's country sites and to the American site's tracking frame are read too.

## Live test

Set `MEEST_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/meest/adapter.live.test.ts`.
Optionally set `MEEST_UNKNOWN_NUMBER` to check a number the tracker does not know.
