# Fixtures

Each fixture follows the reply of `GET kdexp.com/service/delivery/new/ajax_basic.do?barcode=`,
the lookup Kyungdong's tracking page makes, with the form fields the server echoes around it.
A parcel is in `data`, with its scans oldest first.

- `delivered.json` is a parcel sent off by one branch, loaded on two line-haul trucks, the second
  naming its masked driver, scanned twice on arrival at the delivering branch, out for delivery
  and delivered, the delivery naming the driver. Clocks carry a fraction of a second on some
  scans. The summary names the sender, the recipient, their addresses and phone numbers and the
  goods.
- `in-transit.json` is a parcel waiting at its delivering branch, whose name carries no number.
- `not-found.json` is the answer for a number the tracker holds nothing for or failed to look up.

Waybills, branches, people, addresses, phone numbers, goods and clocks are invented.
