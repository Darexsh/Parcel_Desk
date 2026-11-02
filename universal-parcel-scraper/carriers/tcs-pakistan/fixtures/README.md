# Fixtures

The replies follow the tracking page's lookup through `www.tcsexpress.com/apibridge` for one
consignment: the booking details, the delivery records newest first, the checkpoints newest
first and a summary. `delivered.json` is a domestic delivery with a signatory, a merchant
reference and a checkpoint repeated. `in-transit.json` is a consignment on its way with an
expected delivery date in its summary. `attempted.json` is out for delivery again after a closed
premises attempt and a wait for the next round. `booked.json` lists the booking details and a
summary without checkpoints. `not-found.json` is the reply for a consignment TCS does not know.

Numbers, names, stations, references, phone numbers and clocks are invented.
