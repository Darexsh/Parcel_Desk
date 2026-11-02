# Boyuan Supply Chain

Boyuan Supply Chain parcels use enabled universal providers. There is no dedicated adapter.

Boyuan Supply Chain (博远供应链, Guangdong Boyuan) is a Chinese cross-border forwarder with small
parcel lines to the United States, Europe, Britain and the Middle East. Its site is boyuangyl.com.

## Numbers

Its tracking numbers read `BY`, fourteen digits and `CN`. ParcelsApp names DHLink beside Boyuan
for one on a US line, so the rule is low confidence and shared with
[DHLink](../dhlink/README.md), the carrier recognition asks about it.

## Why there is no adapter

Its tracker is a tenant of the Hualei (华磊) forwarder platform, like
[GZYL's](../gzyl/README.md): `selectTrack.htm` on plain HTTP port 8082 of tms.boyuangyl.com
answers without a session. The page on port 443 has an expired certificate, and the same page on
port 8082 asks for a login, so the catalog sends people to the home page's search form. No
public number has been found to check the interface with.

## Links

The tracker page opens a number from its `documentCode` parameter.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
