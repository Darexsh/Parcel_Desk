# Fixtures

The files follow the shape of myDSV's public replies: the search's shipment list, a shipment's
details and its history. Ids, keys, parties, places, ports and clocks are invented.
`search-air.json` finds an air shipment by its house bill, which only `details-air.json` names;
`statuses-air.json` is its history, with port data, earlier values of some rows and estimates,
ending with the handover. `search-road.json` finds a road shipment by its booking id;
`statuses-road.json` is its history without port data, picked up and with a delivery estimate.
`search-empty.json` is the search's reply for a number it does not know.
`schenker-search.json`, `schenker-land.json` and `schenker-empty.json` follow the former DB
Schenker tracker's search and road shipment details: a shipment found by its STT, booked under
another STT, with one package, a duplicated row and a failed delivery with its reason, and the
search's reply for a number it does not know.
