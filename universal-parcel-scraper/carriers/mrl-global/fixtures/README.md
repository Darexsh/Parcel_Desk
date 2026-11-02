# Fixtures

`delivered.html` follows the page `www.mrlglobal.com/tracking/?connoteno={number}` renders for a
consignment it knows, without the site's header, footer and styles: the progress picture, a box
with the consignment's number, the sender's reference, the delivery's clock and who signed, the
latest update, a commented-out copy of both that the page keeps, and the history grouped by event
label and then by day, each group newest first. The groups come in the page's own order, which
follows neither the clocks nor the progress, and two rows share a minute. Its depot scans have
the empty brackets the page prints.

`in-transit.html` is a two-item consignment on its way, built on the same template; no reply for
a consignment still on its way was seen. Its depot scans name their depots in the brackets, and
one pickup row is repeated for the second item.

`not-found.html` is the page's answer to a number it does not know: no details, the error line
and the empty search form.

Numbers, references, names, depots and clocks are invented.
