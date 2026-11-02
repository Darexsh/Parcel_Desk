# Fixtures

The fixtures follow the XML `getTrackXML.html` returns for one national waybill, newest scan first,
with the sender, recipient, reference and delivery fields the page reads. `delivered.xml` goes
from a FedEx Location drop-off to the delivery: a delay scan is repeated, the parcel waits at the
destination depot before it is delivered, and the reply carries a recipient's address and a
signatory. `in-transit.xml` has a scan with a code the status map does not know, a depot the reply
does not mark for display, and an accented depot name; the tests send it in ISO-8859-1 as tnt.it
does. `not-found.xml` is the answer for a number TNT Italy does not know.

Numbers, names, addresses, depots and clocks are invented.
