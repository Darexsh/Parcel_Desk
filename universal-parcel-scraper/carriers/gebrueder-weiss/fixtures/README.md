# Fixtures

The JSON files follow the shape of the public search's reply: a page of shipments, each with
its references, type, estimate, weight, sender and recipient places and status events, newest
first. `delivered.json` is a road shipment. `home-delivery.json` is a home delivery that fails,
is sent back and has events recorded twice, once without a place, an internal event the page
hides and a scan from a branch outside Central European time. `empty.json` is the reply for a
number and postcode the search does not find. `rejected.html` is the firewall's rejection page.
Numbers, references, branches, places, customer numbers and clocks are invented.
