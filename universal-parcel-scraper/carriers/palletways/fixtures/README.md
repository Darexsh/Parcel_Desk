# Fixtures

`delivered.html` and `in-transit.html` follow the HTML fragment `tt_basic.php` returns for a
tracking ID: the status table with one delivery job, then the form asking for the delivery
postcode. `delivered.html` is a completed job, as the tracker answers it. `in-transit.html`
carries one of the portal statuses Palletways' FAQ lists; its badge class is invented, since no
live reply for an open job was seen. `not-found.html` is the notice for an ID the tracker does
not know, and `refused.html` the server's answer to a request its page script would not make.

Tracking IDs, references, days and weights are invented.
