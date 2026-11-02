# Fixtures

The pages follow the shape `/id/cek-awb/{number}` renders for one number: the summary table
headed with the number, then the events newest first, each with a day, a month, a year, a
clock, a heading and a remark.

- `delivered.html` goes from the check-in at the head office to the delivery, whose heading and
  summary name the receiver.
- `in-transit.html` crosses New Year on the way to the next hub; its summary status is cut
  short.
- `returned.html` holds a Tokopedia booking code and has a failed run listed twice, whose remark
  names the courier and a phone number, then a held shipment and the return to the sender.
- `not-found.html` is the notice for a number the tracker does not hold.

Numbers, names, phone numbers, places and clocks are invented.
