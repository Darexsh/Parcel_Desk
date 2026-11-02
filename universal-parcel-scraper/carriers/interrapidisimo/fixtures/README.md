# Fixtures

The tracker's three replies, as `gateway.interrapidisimo.com` gives them. `search.json` is the
search's answer for a guide it knows: the session the page opens the result with.
`search-not-found.json` is its answer for a guide it does not know.

`delivered-summary.json` and `delivered-milestones.json` are the summary and the milestones of a
guide delivered at the second attempt: a failed attempt, the wait for instructions and a second
round come before the delivery. `in-transit-summary.json` and `in-transit-milestones.json` are a
guide for collection at an office, still travelling; it leaves before its origin warehouse scan
and two milestones share a clock. `milestones-not-found.json` is the milestones service's answer
for a guide it has none for. `blocked.html` is an Akamai block page in place of a reply.

Numbers, sessions, places, addresses and clocks are invented.
