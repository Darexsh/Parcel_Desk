# Afghan Post

Afghan Post parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Afghan Post prints UPU S10 numbers ending in `AF`, and its tracking page asks for the
13-character barcode. An archived lookup on its former tracker shows a letter it sent abroad
under another post's number. Generic postal detection handles S10 numbers, so Afghan Post has
no rule of its own.

## Links

The tracking page at track.afghanpost.gov.af posts the number to a script that answers in a
pop-up window, so no address opens one parcel. The former tracker on afghanpost.gov.af read the
number from the `ID` parameter of `/track/index.php`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
