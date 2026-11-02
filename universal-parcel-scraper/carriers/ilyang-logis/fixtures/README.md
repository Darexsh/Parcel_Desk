# Fixtures

Each fixture follows the reply of `POST www.ilyanglogis.co.kr/tracking/trackingByDeliNo.do`, the
lookup Ilyang Logis' tracking result page makes. The parcel is the one entry of `rows`, with its
checkpoints oldest first in `tracking`. Like the real reply, each carries the sender's and
recipient's names, addresses and phone numbers, the goods, the order number, the person who took
the parcel, the staff's codes and phones and the branches' phones.

- `delivered.json` is a parcel taken in and sent off by one office, through a terminal, to its
  delivering branch, which records its arrival twice, does not deliver it one evening for want of
  a driver (the remark adds a phone number), takes it out the next morning and delivers it.
- `in-transit.json` is a parcel that has arrived at its delivering branch.
- `handed-over.json` is a parcel the delivering branch hands to CJ Logistics, the remark giving
  CJ's waybill, after which the sending office records taking it in.
- `not-found.json` is the answer for a number the tracker holds no parcel for.

Waybills, branches, people, addresses, phone numbers, goods, codes and clocks are invented.
