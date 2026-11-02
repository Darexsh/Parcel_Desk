# Fixtures

`header.html` is the tracking box every page loads into its header, `TopHeader.aspx`: the
WebForms form with its state, the number field, its Go button and the network search beside it.

The detail pages follow `Frm_DocTrackWeb.aspx`: the number echoed, the booking detail (from and
to centers, day and clock, consignee), the jobs oldest first and the status line over the
offices' phone numbers. The form's address holds the encrypted key, with a `+` and a `/`.

- `delivered.html`: a delivered consignment. The jobs table is hidden and empty, and the status
  line gives the delivery's day and office.
- `in-transit.html`: a consignment sent through two offices to its destination center and
  received there. Each office name is a link whose tooltip holds the office's address and
  phone number, and an IN row also names the office the consignment came from.
- `not-found.html`: the page for a number without a booking: the number echoed and every field
  empty.

Numbers, keys, page state, offices, centers, addresses, phone numbers, names and clocks are
invented.
