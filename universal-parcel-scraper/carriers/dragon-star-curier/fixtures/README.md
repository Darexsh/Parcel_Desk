# Fixtures

The pages follow DSC's tracker at `dragonstarcurier.ro/tracking-awb?awb={number}`, trimmed to
its tracker content.

`returned.html` has the shape of a live parcel page: the AWB number in the heading, the progress
bar, the Delivery details with the number, the Status box and the current place, then the
Delivery history, newest first, and the search form again. Its parcel was picked up, crossed two
hubs, came back and is held by an exception, and its Status box heads that with the phase
`Returnat`. `in-transit.html` is a parcel between hubs, with one scan repeated.
`not-found.html` is the page with the tracker's notice for a number it holds nothing for.

No delivered parcel was seen live, so `delivered.html` uses the Romanian word for delivered as
its phase and last scan, followed by a recipient's name and phone number, to check that neither
is kept.

Numbers, places, clocks, the recipient's name and the phone number are invented.
