# Fixtures

The pages follow Pack-Man's server-rendered search page, cut down to its form and the result
under it: the voucher, the current status and a timeline of every scan, oldest first. Each scan
shows its Athens clock to the minute, with the seconds and an offset in its `datetime`, and a
remark under it.

`delivered.html` goes from the booking to the delivery across the end of summer time, then on
to the invoicing steps the adapter leaves out: the collection is listed twice, the driver's scan carries an offset that
does not read its shown clock in Athens, and the delivery's remark names a recipient and a phone.
`in-transit.html` is with a driver in summer time. `not-found.html` is the answer for a voucher
Pack-Man does not know, and `challenge.html` stands in for a bot check in front of the site.

Vouchers, names, phones, remarks and clocks are invented.
