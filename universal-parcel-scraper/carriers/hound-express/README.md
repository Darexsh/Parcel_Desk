# Hound Express

Hound Express parcels use enabled universal providers. There is no dedicated adapter.

Hound Express is a Mexican courier for e-commerce and cross-border parcels, including imports
it clears through Mexican customs before delivery.

## Numbers

Hound Express's FAQ describes guide numbers of sixteen digits or of twenty-two characters,
digits with at times one letter among them. Its partner API documentation shows sixteen-digit
guides and one guide of `HP` followed by sixteen digits. Sixteen digits are a run other
carriers share and the `HP` layout has a single example, so no rule claims either.

## Links

The tracker sends the number in a POST request, so no address opens one parcel. The page's
script posts a JSON list of `{"guideNumber": …}` to
`ws_pods.hound-express.com/Sabueso/ws/deliveryServices/trackOrder` with the partner key it
embeds for every visitor in a `partnerKey` header. An unknown number answers HTTP 200 with an
empty `resultDetails` list and a `GONULL` warning. The page reads a found guide's scans from
`resultDetails`, each with a `statusObj` id, a `dateTime` and a `location`. No found reply has
been seen, so there is no adapter yet.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
