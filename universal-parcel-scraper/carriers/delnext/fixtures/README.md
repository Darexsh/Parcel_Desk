# Fixtures

The files follow the Portuguese page `GET /PT/track_your_parcel?tracking_code={number}&reloaded=PT`
on `www.delnext.com` returns, cut down to its login form, its hidden notices, the header naming
the code, the progress bar, the history and the script that holds the code asked.

`delivered.html` is a parcel delivered after a failed attempt and a new delivery day: the
failed attempt carries the system's note, the new day is followed by a notice, one round is
listed twice, and the page names the receiver in its proof of delivery. `in-transit.html` is a
seven-character code still on its way, with a delivery estimate. `returned.html` is a parcel
returned to the sender after a failed delivery; the return and a warehouse scan share a minute,
and the hidden notice names a partner the header does not. `partner.html` is a parcel DPD
Germany delivers: no scans, the partner in the header and its number in the hidden notice.
`cancelled.html` is a parcel the sender cancelled, with one line without a day.
`not-found.html` is the empty search page the tracker gives a code it does not know.

Codes, numbers, names and clocks are invented, and no parcel passed through the places.
