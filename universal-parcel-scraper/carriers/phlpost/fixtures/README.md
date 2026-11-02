# Fixtures

The files follow the shape of the tracker's `POST /Home/GetTrackingEventsJson` reply: an array
of rows, each naming the item code, with a .NET date, the event's wording, a null status, the
country of an IPS scan, the clock the page shows and a status code. Rows of the domestic delivery
system name no country and give their clock to the minute; IPS rows give it to the second. As in
the live reply, wordings keep stray spaces and the domestic rows come before the IPS rows.

`inbound-delivered.json` is mail from Japan delivered in the Philippines, with a repeated IPS row
and a receiver named in the delivery. `outbound-delivered.json` is a PHLPost item delivered in
the United States. `in-transit.json` is mail from China held at customs in the Philippines.
`not-found.json` is the reply for a code the tracker does not know.

Item codes, receivers and dates are invented.
