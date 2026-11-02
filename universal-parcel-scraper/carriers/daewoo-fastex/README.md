# Daewoo FastEx

Daewoo FastEx parcels use enabled universal providers. There is no dedicated adapter.

## Why there is no adapter

FastEx's tracking page posts the number with a web track code, a numeric code the visitor
types in a second box, as `{"searchId": number, "webTrack": code}` to
`POST careconnectapi.daewoo.net.pk:4432/api/Tracking/tracking`. The page does not supply the
code, and it answers HTTP 404 with "No tracking data found" for a made-up number. The Daewoo
FastEx Android app (`com.daewoo.fastex`) asks for the same code and sends it to its own
service. Daewoo Express's ticketing app (`com.app.daewoo.miles`) keeps an older FastEx screen
that took the number alone, but the FastEx service it called no longer exists. Tracking FastEx
would need the code as a second carrier input, which the catalog does not have, so Daewoo FastEx
stays on universal providers.

## Numbers

Daewoo FastEx tracking numbers are nine digits. Archived lookups on its tracker carry them. No
rule claims them: many carriers print nine-digit numbers.

## Links

FastEx's tracking page asks for a web track code with the number and ignores a number in its
address, so no address opens one parcel. Links to the tracking page carry the number in
`trackingNo`.

## Testing

Provider live-test inputs and commands are in the [provider
READMEs](../../providers/README.md).
