# Vitran Express

Vitran Express parcels use enabled universal providers. There is no dedicated adapter.

Vitran Express is a Canadian less-than-truckload carrier of TFI International. Its quick track
page looks up one PRO bill number and shows the current status, the pickup date, the origin and
destination cities and the scan history.

## Numbers

Vitran prints a PRO bill number of digits only; its quick track page asks for digits without
spaces, up to 20. The archived lookup on that page shows eight digits. Bare digit runs of that
length are other carriers' numbers and references too, so no rule claims them and a gap
declaration covers the layout.

## Links

`vitran.com/quicktrack.aspx?p={number}` opens one shipment: an archived lookup on Vitran's own
host uses it. The form on the same page posts the number instead.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
