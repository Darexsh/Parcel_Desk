# Transport RDL

Transport RDL parcels use enabled universal providers. There is no dedicated adapter.

Transport RDL is a Quebec carrier that delivers parcels in Eastern Quebec and northern New
Brunswick with its own vans, for national couriers and for Amazon. Amazon.ca names it RDL.

## Numbers

No public source shows a whole Transport RDL number, so the corpus is empty and no rule claims
a layout.

## Links

`transportrdl.com/suivre-un-colis` with `tracking-number` opens one parcel; the site's tracking
forms send the number that way.

## Why there is no adapter

The tracking page looks the number up on the server and writes the answer into the page; no
script or service behind it shows the shape of a result. It answers a number it does not know
with a notice that repeats the number, and its form checks nothing about the number's layout.
No public source shows a Transport RDL number, so the page's answer for a known parcel has
never been seen and an adapter would have nothing to read. Transport RDL stays on universal
providers until a real number shows that answer.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
