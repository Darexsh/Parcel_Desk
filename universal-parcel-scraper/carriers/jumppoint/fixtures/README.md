# Fixtures

Each file follows the reply of `tracking-api.jumppoint.io/shipment/tracking/` for one number,
with its status log oldest first and its clocks in UTC.

- `delivered.json` is a parcel taken to the door: a repeated warehouse row, a confirmation, a
  failed attempt with a coded reason, a rescheduling with free-text remarks, then the delivery
  with a free-text remark naming who signed. It carries the courier's name and phone and the
  merchant's order number.
- `in-transit.json` was dropped off at a pick-up point and is on its way to another, whose
  details and order number it carries.
- `created.json` is a waybill the merchant created, without a status log.
- `not-found.json` is the answer for a number Jumppoint does not know: the number again,
  without a state.

Numbers, names, phones, places and clocks are invented.
