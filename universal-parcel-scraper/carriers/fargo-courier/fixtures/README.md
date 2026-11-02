# Fixtures

The fixtures follow the page `portal.fargocourier.co.ke/track?blank=1&wayBillNumber=…` returns
for one waybill: a summary, the proof of delivery, the sender and receiver, and the waybill's
events, newest first. `delivered.html` goes from the waybill's creation at one branch over a
linehaul to the hub, where it is delivered and invoiced. `in-transit.html` is a seven-digit
waybill that has reached the receiving depot, without the proof of delivery. `error.html` is
the tracker's error page, which it returns with HTTP 500 for a waybill it does not have.

Waybill numbers, references, names, branch codes, places and clocks are invented.
