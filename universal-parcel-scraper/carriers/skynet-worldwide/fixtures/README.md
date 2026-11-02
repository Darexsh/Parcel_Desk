# Fixtures

Each fixture follows the tracker's page for one number, `go/plm-tracking?stid=skynet&cn=`,
trimmed to the markup around the history and the script the server writes it into, block for
block as the page writes it.

`delivered.html` goes from a collection in the United Kingdom to a delivery in Canada, under the
page's four sections: a branch hold, a scan in the hour the British clocks repeat, an "Others"
location, a customs hold and release, a message to the recipient, a failed attempt and a delivery
with the masked signatory. `in-transit.html` was collected in Singapore and waits at customs in the
United States, with a delayed departure and a message to the recipient as its newest scan.
`not-found.html` is the page for a number the tracker holds nothing for.

Numbers, places, clocks and the signatory are invented.
