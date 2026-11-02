# Korea Post

The adapter submits the official English international-mail form through HTTP.
It checks the parcel in the basic-information table before reading the history
table.

Thirteen-digit domestic numbers are read from the official domestic tracking
page with one GET. The adapter checks the number in that page's
basic-information table, then reads the date, time, office link and status label
of each scan. Domestic scans all happen at Korean offices, so their clocks are
read in Korean time, and a delivered last scan gives `delivered_at`. The page's
own "no delivery information" notice is the only not-found answer.

The international portal uses destination-local scan times after handover. The adapter
retains those wall clocks as `local_time` and reverses the portal's oldest-first
sequence without inventing offsets. `last_update` stays empty so providers can
supply dated history. The details column mixes routing notes and recipient data;
the adapter reads only the dedicated status and facility columns. On the
domestic page the status cell goes on with the courier's name and phone or the
recipient, and the basic table names sender and recipient; none of them is read.

Run `npm run test:carriers:live -- carriers/korea-post`.
Set `KOREA_POST_TRACKING_NUMBER` outside the repository for a real international
parcel.

## Limitations

Detection suggests Korea Post for thirteen digits that start with 1 to 6:
domestic parcels start with 6 and registered letters with 1 to 5. Other carriers
share that length, so the number stays a suggestion, and Korea Post has no
recognition step to confirm it. Callers select Korea Post explicitly.
