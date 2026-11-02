# Wahana Express

Wahana Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Wahana Express prints an eight-character resi of digits and capital letters in random order, as
its FAQ describes. The shape is too generic for a detection rule, so a number is only matched
to Wahana when the user or a provider names the carrier.

## Links

The tracker reads up to ten numbers, separated by spaces, from the `noresi` query parameter
of `/lacak-kiriman` on `www.wahana.com` and `wahana.com`, and the library reads the number from
that address. The page shows a history only after its CAPTCHA, so the address alone opens no
parcel.

## Limitations

Wahana's server checks the answer to its tracker's CAPTCHA, a self-hosted Captcheck picture
question. Without a solved one the page answers "Resi tidak ditemukan" for every number, current
parcels included, so that answer says nothing about the number. The result page's PDF download
fails without one too. The Sahabat Wahana app tracks only the shipments booked in the user's own
app account, and the agent and partner portals need an account. The library solves no CAPTCHA,
so Wahana Express stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
