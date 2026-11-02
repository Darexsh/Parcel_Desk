# Jamaica Post

Jamaica Post parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Jamaica Post's international items carry UPU S10 numbers, which generic postal detection
handles. Its Ja Mail tracker shows two other layouts as examples: `ZL` and eight digits, and
`CSN` and four digits. Only those examples are public, so no rule claims either layout.

## Links

The Ja Mail tracker and the Fast Track page take the number in a posted form, so no address
opens one item. The track and trace page sends international items to the UPU's Global Track
and Trace.
The track status form at `track-status.php` carries a CSRF token and posts the number as
`Consignment` to `track-result.php`. An unknown number is reported as not found. No found reply
has been seen, so there is no adapter yet.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
