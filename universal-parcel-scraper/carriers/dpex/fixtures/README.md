# Fixtures

`delivered.html`, `in-transit.html` and `not-found.html` follow DPEX's GETOnline page for one
number, `go/plm-tracking?stid=dpexwwe&cn=`, trimmed to the markup around the history and the
script the server writes it into, block for block as the page writes it.

`delivered.html` is an air waybill from Hong Kong delivered in Singapore, under the page's
three sections, with the masked signatory on the delivery and a scan at midnight.
`in-transit.html` is an air waybill from Singapore on its way to Australia, waiting at the
delivering depot. Both carry a service type and the destination's town. `not-found.html` is the
page for a number the tracker holds nothing for.

The `china-` fixtures follow DPEX China's page, `trace-and-track/index?id=`, trimmed to the
script that holds its three arrays and the page's empty containers, with every key of a scan
and its event as the page writes them. `china-delivered.html` is the first air waybill from its
documents in China to its delivery, with notes on the scans. `china-in-transit.html` is the
second with the documents and the collection, and the platform's scans copied only as far as
Singapore. `china-not-found.html` is the page's entry for a number it holds nothing for.

Numbers, places, clocks, notes and the signatory are invented.
