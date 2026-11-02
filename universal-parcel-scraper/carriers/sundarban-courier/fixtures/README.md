# Fixtures

Replies of the tracking page's lookup, `POST https://operation.sundarbancourierltd.com/Home/getDatabyCN`,
with the history oldest first as the service lists it. Each shipment carries the fields the real
reply has, among them the sender's and recipient's names, addresses and phones, the contents, the
vehicle and manifest numbers and the delivery man.

- `delivered.json` goes from the booking at a branch through two hubs to the delivery, each day
  written at midnight.
- `in-transit.json` has been received at the first hub.
- `not-found.json` is the answer for a number the tracker holds nothing for.

Numbers, names, branches, addresses, phones, vehicles, contents and days are invented.
