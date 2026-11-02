# Fixtures

`delivered.json` and `in-transit.json` follow the reply of myDPD's `parcel/search` for a
parcel looked up without its postcode: the sender and recipient fields are null and the scans
come oldest first, each depot's town and country on its first scan only. `delivered.json` goes
from the order data to a delivery at the recipient's chosen place in winter; one depot scan is
repeated, and the delivery carries that place in `infoData`. `in-transit.json` comes from
German depots and waits in a Pickup station after a failed attempt in summer. `not-found.json`
is the answer for a number myDPD does not know. `challenge.html` stands for the page Radware's
bot manager serves in place of the reply.

Numbers, places, clocks and banners are invented.
