# Shree Mahabali Express

Shree Mahabali Express parcels use enabled universal providers. There is no dedicated adapter.

Shree Mahabali Express is a domestic courier network based in Surat, India.

## Numbers

The tracker takes AWB numbers. A lookup archived from it shows a ten-digit AWB number.
Ten-digit runs are printed by many other carriers, so no rule claims them.

## Links

The tracking page, `Frm_DocTrack.aspx`, took the AWB number as `No` (plus a cache-busting `Tmp`
timestamp), so such a link names one parcel and the number is read from it.

## Why there is no adapter

The site now serves a static copy of its former pages. Its tracking form still opens
`Frm_DocTrack.aspx`, but that page, like every other `.aspx` page, redirects to the home page.
The Android app (`com.infosoftsolution.shreemahabaliexpress`) tracks an AWB number without an
account through the `FetchAWBNoData` operation of a SOAP service on `smelonline.com`, reading
the number, its status, the last centre and the scans from the reply. That domain is on registrar
hold and resolves to a loopback address, and the service's server does not answer from India,
Singapore or Europe, so Shree Mahabali Express stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
