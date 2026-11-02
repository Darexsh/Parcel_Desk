# Fixtures

Each file follows a page of the NetSuite script that `www.amtrucking.com/track-number.php`
redirects to, as AM Home Delivery serves it.

`delivered.html` goes from the consolidation center to the completed delivery, with a timed
delivery appointment, the progress rail complete, a row whose place is `In Transit` and one row
repeated. `in-transit.html` is an AM number at the delivery terminal with a range of days as its
estimate, its last mile status `Scheduled` and a row without a place. `pending.html` is an order
waiting for its pickup, without a history or an estimate. `not-found.html` is the notice for a
number the page holds no shipment under.

Numbers, bill of lading numbers, products, towns, ZIP codes, contact details and clocks are
invented.
