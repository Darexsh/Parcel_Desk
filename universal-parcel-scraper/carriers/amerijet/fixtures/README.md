# Fixtures

`delivered.json` and `in-transit.json` follow the reply of `tracking/getTrackingInfo`: one row per
scan, listed by milestone rather than by time, as the tracker sends them. `delivered.json` goes
from the booking through a truck leg and a flight to the delivery at the destination station.
`in-transit.json` stops after part of the shipment's pieces left the transit station.
`not-found.json` is the answer for an air waybill Amerijet does not know.

Air waybills, stations, flights and clocks are invented.
