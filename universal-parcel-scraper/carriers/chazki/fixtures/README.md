# Fixtures

The replies of the GraphQL service behind Chazki's tracking page, cut to the fields the adapter
asks for. `search.json` is the page's search (`getOrderPublicTrackCode`) finding one order, and
`not-found.json` its empty answer for a code Chazki does not know. `delivered.json` and
`in-transit.json` are orders (`getOrderPublic`), with their history rows in no order, as the
service sends them. `delivered.json` goes from the order entered to the delivery, with rows the
page does not show and both trips to the sender in the same minute. `in-transit.json`, under a
lettered code, had a failed delivery and a new date before the driver set off again; its clocks
include midnight and noon.

Trackcodes, order ids and clocks are invented.
