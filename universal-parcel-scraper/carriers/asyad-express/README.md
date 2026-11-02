# Asyad Express

Tracks Asyad Express shipments and Oman Post items through the guest lookups in the
[official Asyad Express app](https://play.google.com/store/apps/details?id=com.asyadexpress.asyadexpress).

## Retrieval

One `direct` step reads `apix.asyadexpress.com/v1/customer/order/{number}/ultimate-history`
with the shared guest authorization shipped in the app. An explicit miss then asks
`poboxes.omanpost.om/TrackOrders/api/MyUSWebApi/TrackingDetails?TrackingID={number}`, without
authorization. Only explicit missing replies from both systems establish absence. Outages,
block pages, failed authorization and malformed replies retain their failure kinds.

The express request names the whole shipment in its path; the postal response also echoes the
whole item identifier. Scan wording and codes are retained. Free-form remarks, recipient and
contact fields are excluded. Enabled providers can supplement the postal network's history.

Scan times keep their local wall clock. A postal office code or an explicitly identified Omani
facility also supplies a deduced instant with its place basis; express scans abroad without a
place keep no invented offset. The source's event sequence is preserved across different clocks.

## Numbers

Asyad Express runs Oman's parcel and express tracking for the national postal group, Oman Post.
Its shipment numbers seen so far are plain digits with no documented length or prefix, so no
rule claims them. International postal items keep the UPU format and are left to generic
postal detection.

## Links

The tracker, `asyadexpress.om/track-trace`, takes the number as a path segment and accepts
up to ten numbers. Older Oman Post links use `omanpost.om/Tracking/` with `trackingno`.

## Limitations

The public website can refuse foreign networks. The mobile tracking hosts use a separate access
path and can be reached directly; consumers can supply a scoped transport if their network
cannot reach them. No proxy credential or account setup is required by the adapter.

## Testing

Set `ASYAD_EXPRESS_TRACKING_NUMBER`, optionally `OMAN_POST_TRACKING_NUMBER` and
`ASYAD_EXPRESS_UNKNOWN_NUMBER`, outside Git, then run:

```sh
npm run test:carriers:live -- carriers/asyad-express
```
