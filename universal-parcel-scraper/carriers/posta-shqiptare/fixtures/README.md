# Fixtures

Each file follows the shape of the e-Posta tracker's `getTrackApi` reply for one item: its scans,
newest first, each with a clock, the wording, the office and an empty destination.
`delivered.json` is an item sent to Austria in summer and delivered there, `in-transit.json` an
item sent to Serbia in winter after a failed delivery, with one relayed scan repeated, and
`courier.json` an EMS item a courier carried to Greece, whose delivery names a recipient and
whose arrival office starts with a postcode. Numbers, offices, towns, the recipient and clocks
are invented. An unknown code gets an empty list, which the tests build inline.
