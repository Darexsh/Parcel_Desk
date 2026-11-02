`delivered.json`: a `/shipments/{shipment}/Pak` payload for a delivered Quickpac
parcel (the four milestone labels in API order, a delivery day, a transport
position of another shipment, the parcel's weight and measurements, and the
delivery address's country) plus recipient, address and signature fields the
parser must drop. Labels and timestamp format match the live API; the number, second
position, names and signature URL are synthetic.
