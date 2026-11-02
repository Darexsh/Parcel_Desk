# Starlinks Global

Starlinks Global is a British cross-border carrier that takes online shops' parcels from its
hubs in the United Kingdom abroad, through customs, and hands them to a courier or post in the
destination country, which delivers them under its own number. It is not the Saudi courier
Starlinks. Tracked through its tracking page.

## How it works

1. `direct`: one `GET https://starlinks.app/track/{number}`. It needs no cookie, token, key or
   browser. The page's tracking component carries the parcel as JSON in its `:parcel`
   attribute, and the number searched in `:search`.
2. `retry`: the request once more when it fails to reach the site or hangs. The first try gets
   half of the budget, so the retry fits in the rest.

- A number the tracker does not know leaves the parcel null with the error `Parcel not found`,
  read as not found. A null parcel with another error leaves the answer open.
- The page answers every number with HTTP 200, so a redirect or a 404 is a moved route, and a
  firewall page is a challenge.
- The tracker also finds a parcel by its courier's number. The adapter asks only for a Starlinks
  Global number, and reads only a parcel whose own number and search are the whole number asked.
- The page hides a cancelled parcel's history, so a cancelled parcel leaves the answer open.
- Recognition makes the same request.

## Notes

- Each event has a title from a short list and a text beside it. The text is kept, or the title
  when the text is empty, and the title decides the stage before the text.
- A text can end with `at` the place and its country, or the country alone. The place and its
  country become the location; a country alone names none.
- Event clocks are wall clocks to the second with no zone, so they stay `local_time`. Node
  lookups date them on the zone of their place or leg, else London.
- The courier the tracking link's address names becomes the delivery carrier, with the
  courier's number when it differs from the one asked. The page's name for the courier is
  Starlinks Global's label for its service, so it names none.
- The destination country and the weight in kilograms are read. The shop and the recipient's
  town are not.

## Limitations

- No instants, scan codes, expected delivery or proof of delivery.
- A parcel whose courier the catalog does not know has no delivery carrier.

## Numbers

A Starlinks Global number is three letters naming the shipper, four digits, the country the
shipper sends from and eleven digits. FedEx International Connect labels its parcels the same
way, and neither tracker knows the other's numbers, so both rules are low-confidence and FIC,
with many more shippers, comes first.

## Links

A link to the tracking page with the number in its path opens one parcel. The page also opens
a parcel under its courier's number, so the link names Starlinks Global only for a number its
own rule offers.

## Testing

`npm run test:carriers:live -- carriers/starlinks-global`, with
`STARLINKS_GLOBAL_TRACKING_NUMBER` and optionally `STARLINKS_GLOBAL_UNKNOWN_NUMBER` set outside
the repository.
