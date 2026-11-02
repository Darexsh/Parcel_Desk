# PMM

PMM parcels use enabled universal providers. There is no dedicated adapter.

PMM (Paquetería y Mensajería) is a Mexican parcel and freight carrier based in Mazatlán.

## Numbers

Its tracker takes a tracking number or a business waybill of ten to twenty letters and digits.
The only example seen, in the help chat on its website, is twelve digits, a letter and four
digits. One example is too little to claim the layout, so no rule is proposed.

## Links

The tracker's route `pmm.com.mx/rastreo/{number}` looks the number up on load, and is read as a
link.
The page looks the number up with an anonymous GET to
`apibase.pmm.com.mx/pagepmm/api/v1/rastreo?numero={number}`. An unknown number answers HTTP 404
`NOT_FOUND`, "El numero de rastreo no existe". No found reply has been seen, so there is no
adapter yet.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
