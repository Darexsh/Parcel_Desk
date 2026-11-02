# Jetpak

Jetpak parcels use enabled universal providers. There is no dedicated adapter.

Jetpak is a Nordic time-critical courier, same day by air and road and next day, in Sweden,
Norway, Denmark and Finland. Its site is jetpak.com.

## Numbers

Its tracker says booking references start with `JET` or `999`. No length is published and no
public reference has been found, and `999` is also an airline's air waybill prefix, so there is
no rule.

## Why there is no adapter

Its tracker reads an open JSON lookup, but no public reference has been found to check a found
reply with.

## Links

The tracker's address carries the booking reference after `track/awb/`. Its addresses for a
consignment's hash come from notification e-mails and are not read.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
