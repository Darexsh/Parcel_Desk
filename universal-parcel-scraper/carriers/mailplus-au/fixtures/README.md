# Fixtures

Replies of the lookup MailPlus's tracker makes,
`wapp.mailplus.com.au/api/v1/customer/trackings/public/{number}`, in the shape the page
receives them. Numbers, barcodes, places and clocks are invented.

- `delivered.json`: a parcel MailPlus collected and lodged with Australia Post, delivered. The
  reply follows it under an invented Australia Post barcode and pairs some of Australia Post's
  scans with a bare status at the same minute. Its clocks cross the end of daylight saving.
- `in-transit.json`: a parcel asked by its MailPlus number, booked for collection, collected,
  lodged with a partner and in transit, with a delivery estimate of two days.
- `not-found.json`: the HTTP 409 reply for a number the tracker does not hold.
- `invalid.json`: the HTTP 400 reply for a number whose layout the tracker does not take.
