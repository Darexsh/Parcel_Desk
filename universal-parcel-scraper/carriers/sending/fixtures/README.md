# Fixtures

The detail pages follow the page `info.sending.es` opens for a shipment after its search form's
lookup, cut down to the heading naming the shipment, the progress rail, the scans newest first
under the day they happened, the block of sender, recipient and branch details, and the script
that sets the rail's phase.

- `delivered.html` is a shipment delivered after a failed attempt and an address the recipient
  corrected. A receipt beside the delivery names whoever took it.
- `in-transit.html` is a shipment on its delivery rounds after an incomplete address, with a
  sender's reference, the page's delivery options and a scan dated to the day alone.
- `missing.html` is a shipment the rail writes off as missing after failed attempts.
- `not-found.html` is the tracker's page for a number it does not know.

Numbers, references, names, places, postcodes and clocks are invented.
