# Kronos Express

Kronos Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Kronos Express is a Cypriot courier that delivers within Cyprus and carries parcels from
Greece to Cyprus. Its tracker asks for a shipping number without naming a layout. The only
public number seen is a voucher of six letters and seven digits, which the WooCommerce plugin
connecting shops to Kronos Express shows in its screenshots. A single shop's voucher cannot
tell which part of it is fixed, so no rule claims it.

## Links

The tracker on `tracking.kronosexpress.com` reads the number from `tracking_number`, so
`tracking_system_en.aspx?tracking_number={number}` opens one parcel in English and
`tracking_system.aspx` in Greek. The shop plugin links the Greek page.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
