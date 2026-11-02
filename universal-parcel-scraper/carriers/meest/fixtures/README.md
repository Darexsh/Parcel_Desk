# Fixtures

The XML files follow the shape of the tracker's `get.php?what=tracking` reply: every row that names
the number, oldest first, with its numbers, clock, place, code and wording in Ukrainian, English and
Russian. `transit.xml` is a consolidation from China at a hub abroad, with the consolidator's own
registration, a day without a time and a scan reported twice. `partner.xml` is a consolidation a
partner feed takes on to a locker abroad and names the final-mile carrier for. `domestic.xml` is a
parcel from the United States cleared and delivered in Ukraine under another barcode, with a row the
page hides. `reference.xml` is the reply for a number Meest notes only as a partner's reference,
`not-found.xml` for a number Meest does not know and `error.xml` for a lookup the tracker refused.
`page.html` is the tracking page with the salt its script signs lookups with. Numbers, places,
clocks, branches and the salt are invented.
