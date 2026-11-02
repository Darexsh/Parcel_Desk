# Fixtures

The `summary-*.html` pages follow XPO's former PRO tracking page: the template's redirect
script, the "PRO Tracking" heading, then one status block with the status code in its
definitions link, the PRO, the status and its service center, the pickup and delivery days, the
parties, the service centers, the references and the shipment details. One shipment is at an
interim service center with an estimate; the other is delivered and shows its delivery day.
`summary-not-found.html` is the notice for an unknown PRO, naming its eleven-digit form.

The `history-*.html` pages follow the shipment history page: the PRO heading and one row per
scan, oldest first, with lookups, saves, the system's unload after the delivery and a repeated
row among them, and the delivery route after the out-for-delivery row. `history-not-available.html` is the page of a PRO without one.
`rejected.txt` is the firewall's rejection.

PROs, parties, references, places, service center codes and clocks are invented.
