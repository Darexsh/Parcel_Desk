# 139 Express

139 Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Senders print the 139 international waybill as the leftmost barcode of the label they stick on
the parcel before it goes to 139 Express's warehouse, and the tracker takes that number. An
archived lookup on 139 Express's own tracker shows a twelve-digit one. Twelve digits are a
shape many carriers share, so no rule claims it.

## Links

The tracker's result page reads the waybill from `keyword` on `139express.com/Home/vipsearch`,
so `www.139express.com/Home/vipsearch?keyword={number}` opens one parcel. The search page
posts up to ten numbers to `/Home/Sub_Track` and has no address of its own.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
