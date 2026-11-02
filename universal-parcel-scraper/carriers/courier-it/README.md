# Courier IT

Courier IT parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Courier IT waybills seen so far are a short letter prefix and a few digits. It also carries
PostNet's counter-to-counter waybills, which its tracker shows under the same number. The
shapes are too generic to claim, so no rule is proposed.

## Links

The tracker, `intellitrack.courierit.co.za`, takes the number as `SearchString`. Older links
point to `courierit.co.za/Trackit/Trackit.aspx` with `WaybillNumber`.

The tracker is a Blazor Server app. Its lookup runs over the page's live connection to the
server, and no separate request answers it. For a number it does not know it says it has no
record of the parcel yet, which does not say that the number is wrong.

Courier IT's booking portal, `sendit.courierit.co.za`, runs on Ship Logic, as
[Internet Express](../internet-express/README.md) does. Its track page at `/track?ref={number}`
makes the lookup `GET https://api.sendit.courierit.co.za/tracking/shipments` with
`tracking_reference` and Courier IT's provider id, `210`, in `provider_id`. The portal reads
that id from `/providers?origin=sendit.courierit.co.za`. The lookup needs no cookie, token or
key. It looks up shipments on that portal, and an unknown reference is HTTP 404 naming it.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
