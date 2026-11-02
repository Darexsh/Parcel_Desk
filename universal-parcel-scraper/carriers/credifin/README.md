# Credifin Logística

Credifin Logística parcels use enabled universal providers. There is no dedicated adapter.

Credifin Logística, formerly Credifin Express, is an Argentine parcel network of franchised
branches based in Reconquista, Santa Fe.

## Numbers

The tracking code printed on Credifin's receipt is eighteen digits, ending in the receipt's
own number padded to ten digits. An archived reply of its tracking API shows one, with a
fifteen-digit label for the package that keeps the code's first eight digits. Both are bare
digit runs other carriers also use, so no rule claims them.

## Links

Credifin's home page opens `credifin.com.ar/seguimiento/{number}`, the tracker's own address
for one parcel. Its former tracker on `tracking.credifin.com.ar` took the number as the whole
path; that host no longer answers.
The current tracker reads `thegroup.credifin.com.ar/public/api/guia/{number}` and
`/public/api/seguimiento/{number}` without a login. An unknown number answers HTTP 404, "No
encontramos tu envío". No found reply has been seen, so there is no adapter yet.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
