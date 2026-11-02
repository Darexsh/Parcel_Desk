# JD Logistics

Tracks international waybills through the international website's anonymous feed. When that
feed holds no history, the JDAZ and JDJ domestic series can use the public domestic tracker
through TRAWL. A series is a route suggestion; the response must confirm the whole identifier.

## How it works

One JSON POST queries the website's international tracking proxy. The parent reference must
match the requested number and contain one waybill with dated scans. Multiple pieces are
rejected because selecting one could return another parcel's progress.

For the domestic series, an inconclusive international answer can continue through `trawl`.
The helper opens the official order-search page in a fresh context and uses its own search,
guest session and service-selected verification branch. Its single-icon worker makes one
bounded attempt. An uncertain match stops without clicking, refreshing the puzzle or sending
a history request. Accepted verification must still belong to the original guest session;
only then may the page query `trackNoPin`. The helper also permits the normal proxy request
when the service itself selects the branch without verification.
When a prompt mask falls outside the accepted foreground size, verification diagnostics
keep only its pixel count; puzzle images and mask data are not logged.

The matcher declines most puzzles. After it declines a waybill, the page is not opened for that
waybill for 6 hours, then twice as long after each next decline in a row, up to a day. Those
lookups fail as the same declined verification, so enabled providers answer them. A bound
answer clears the wait; a restart forgets it.

Domestic replies require exactly one matching `rawWaybillCode` and an explicit `exists`.
Only a bound `exists:false` is not found. Empty or refused replies stay inconclusive, and
browser failure or abstention leaves enabled providers available. No phone, login, map,
attachment or proof-of-delivery route is entered. HTTP recognition never starts this browser
step; browser recognition is a separate opt-in.

The domestic page displays `createTime`, otherwise `trackDay` with `trackTime`. An epoch or
explicit offset keeps its instant. A clock without an offset stays local, in the carrier's
order; the page's language does not establish its zone. Contact and recipient clauses are
removed from scan wording, a station's phone too. Each scan keeps its `state` as its provider
code, and the states recorded in `status.ts` give its stage, since the shared wording rules
do not read Chinese; the newest scan decides the status. Wordless or contact-only rows with
valid clocks are omitted; the remaining history is marked incomplete so enabled providers can
fill it. A reply with no readable scans stays inconclusive. Invalid clocks and malformed rows
still fail, and a capped history is also marked incomplete.

For international history, each scan keeps its operation code as its provider code and takes its stage from it
(`status.ts`); a scan with an unknown code is classified by its wording. An order shipped from
JD's own warehouse abroad is accepted there while it is picked and weighed, then handed to a
last-mile partner such as GOFO, whose steps JD relays. GOFO's label comes under a code JD has
shown with that step alone, and GOFO's loading at a hub, before its delivery station, under the
code of JD's courier out with the parcel, so their wording decides them rather than the code.
On a line from China, the parcel is accepted while JD's warehouse there receives, weighs and
consolidates it. The clearance agent's collection at the port of arrival ("Cleanrance agency
picked") and the hand-over to the local carrier are in transit. The departure from the warehouse
ends with the last-mile partner's number ("Tracking no …"), which becomes the delivery tracking
number and leaves the wording; a row stored with it keeps its row. The number names no partner,
and JD already relays the partner's steps, so it hands nothing off.
The newest scan decides the status. The courier's name and phone are dropped from the out-for-delivery wording
(`wording.ts`).

A scan's location is its city and its country in English. JD names the country in Chinese in
`routeCountry` on some scans, by its full name or a usual short form, and in English in
`routeProvinceName` on its international lanes, so either gives the same name. A country read
neither way stays as written; a province adds nothing. A city that is the country itself, such
as Hong Kong, Macau or Singapore, stands alone.

Each scan's wall clock is local to the scan, whatever zone the request names. A scan also
carries epoch milliseconds and a declared fixed offset (`UTC+3`). It is dated, in that offset,
only when the epoch reads as its wall clock there. Every country its place fields name must
also have a single zone known here, and that zone must keep that offset at that wall clock,
neither skipping nor repeating it. Beside the shared single-zone table, the parser knows Saudi
Arabia, Kuwait, Qatar, Bahrain, Oman, Egypt and Macau, so a Saudi scan is dated at +3 and
stays local at +8. A country spanning several zones (United States, Australia, Indonesia,
Brazil), one not known here, or a country field read neither way keeps the clock local. So does
a place naming no country read here, such as a Chinese province and city without a country or
an abbreviation like `KSA`. Only a scan with no place at all, such as the order's creation, is
dated on its epoch and declared offset alone. A fully dated history is ordered by instant, ties
in JD's order; any local clock keeps JD's order, newest first.

## Limitations

Domestic recovery needs the TRAWL image with the JD helper. Its conservative matcher supports
one observed image geometry and declines other puzzles; it does not promise verification on
every lookup. Public unattended history has been observed for JDJ and JDAZ. Domestic clocks
without a stated offset remain unresolved. Other domestic service variants can require
recipient inputs and are not followed. The international feed's empty
answer remains inconclusive with `portal_not_found`, never proof that a parcel does not exist.
A scan without an epoch is not dated from its declared zone alone.

## Testing

Set `JD_LOGISTICS_TRACKING_NUMBER` outside the repository and run
`npm run test:carriers:live -- carriers/jd-logistics/adapter.live.test.ts`.
