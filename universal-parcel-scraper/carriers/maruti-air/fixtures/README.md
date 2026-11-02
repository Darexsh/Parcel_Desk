# Fixtures

`not-found.html` is the page `erp.marutiair.com/TrackpageWeb/WebAWBTracking.aspx?AWB=` renders
for a number without a document: the tracking form with the number left in its field and the
notice "DETAIL NOT FOUND !" under it. Its hidden form values are replaced.

No page for a found document was available, so `delivered.html` and `in-transit.html` fill the
same page in where the notice sits, as the tracker's stylesheet lays a document out: a heading
with the docket number and its status, a progress rail, the document's details and its history
in tables, and the delivery image. `delivered.html` is a document from Surat delivered in Pune
with a staff signature and stamp, its delivery row at midnight; `in-transit.html` one from Mumbai
received in Bengaluru, its history listed oldest first with twelve-hour times. Numbers, names,
places, wordings and clocks are invented.
