# Fixtures

`delivered.xml` follows the shape of the reply `facts.dohrn.com/scripts/cgiip.exe/protracexml.htm`
gives for one delivered PRO without a login: the PRO, references, the shipper's and consignee's
towns and terminals, the pieces and weight, the delivery's clock and status with the signer, the
lifecycle, and the history newest first. It has a failed delivery run, a repeated row, an
appointment, and the manifest and driver's run rows the tracking page leaves out.
`in-transit.xml` is a ten-digit PRO on its way, with an estimate, a row without a time and the
fields of a delivery left empty; no in-transit reply was seen, so its lifecycle is left empty.
`quote.xml` is a rate quote under the number, and `not-found.xml` the error document for an
unknown PRO. PROs, references, parties, places, terminals, signers, weights and clocks are
invented.
