# Fixtures

`delivered.xml` and `in-transit.xml` follow the shape of the SOAP 1.2 reply to the app's guest
status search: the agencies, the consignment note, the state code and wording, the shipping and
target days, and the fields the adapter does not read (destination postcode and town, sender's
reference, shipment key, agency name and contacts). Every number, place, contact and date is
invented, and the two use different namespace prefixes, as the service may. `not-found.xml` is
the empty reply for a number the service does not know; `no-search.xml` is its nil reply to a
search it cannot run.
