# Fixtures

`intelcom-delivered.json` and `usps-held.json` follow the shape of the tracking page's
`se_track_form_submission` reply: the shipment's code, service, ship-to town and country,
tracking number, partner link and carrier phone, then its scans newest first with the partner's
name and a UTC stamp. One parcel is delivered by Intelcom under Stallion's own SE number, the
other handed to USPS under USPS's number. Codes, numbers, places and clocks are invented.
`not-found.json` is the reply for an unknown number and `rate-limited.json` the site's throttle.
