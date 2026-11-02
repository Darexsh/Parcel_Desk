# Fixtures

Each file is the HTML fragment PFC's tracker returns from
`Index?handler=AccessRedirect&nos={number},`, which the reply carries as a JSON string; the tests
encode it. A parcel's `T_item` is classed by the tracker's tab, its first row gives its
reference, tracking number, PFC order number, channel, route, newest scan and status, and its
list gives every scan, newest first, as a message and a month-first wall clock.

`transit.html` is a parcel in transit to Norway, handed to the destination post, whose number
is in the tracking-number column. `delivered.html` is a delivery in the United States: its
scans include a signer, a phone number, a facility code before a wording, a repeated scan and
places after `----`. `returned.html` is a parcel whose export customs stopped, with China Post's
scans relayed in Chinese, among them a courier's name, phones and hotlines. Its order number has
a five-digit account and an unpadded serial and its route has no origin. `not-found.html` is the
item the tracker gives a number it does not know.

Numbers, references, names, phones, towns, the local office and clocks are invented.
