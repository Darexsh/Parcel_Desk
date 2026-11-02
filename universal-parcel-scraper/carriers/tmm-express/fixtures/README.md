# Fixtures

`delivered.html` and `in-transit.html` follow the tracker's English page for one AWB number,
trimmed to its content: the Common information table with the download form, whose hidden
`xmltosave[0]` field holds the consignment as base64 XML, then the Detailed information table of
its scans, newest first. The XML has each scan's code, wording, date, time and depot, as well as
the signatory and a customer reference.

`delivered.html` is an import through the Warsaw hub, released from customs in Kyiv and
delivered after a missed call. One scan is repeated, a change of address carries the new
address after ` - ` and a changed delivery date its time window, and the XML names who signed.
`in-transit.html` came from China and reached a partner's depot in Kyiv; its hub and depot
scans name them after ` - `, and it has a Partner Connote. `not-found.html` is the page with
Drupal's notice for a number the tracker holds nothing for, as archived lookups show it.

Numbers, names, references, addresses, the hub and depot remarks and the clocks are invented.
