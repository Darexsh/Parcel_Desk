# Olva Courier

Olva Courier is a Peruvian courier that delivers across the country from its stores and
warehouses, to the door or to a store for collection. It also delivers AliExpress orders in
Peru. Tracked through the lookup its tracking page makes.

## How it works

1. `direct`: one `GET https://tracking.olvacourier.com/?q={number}`, the address the tracker's
   search form opens. The server looks the number up and writes the answer into the page as
   `OlvaTracking`, a JSON object in a script that the page then draws. It needs no cookie,
   token, key or browser.
2. `retry`: the same lookup once more after a network failure or a timeout.

- The tracker reads Olva's own number only with its hyphen, the year first or last. The facade
  hands adapters numbers without hyphens, so nine or ten digits read two ways. The adapter asks
  the readings whose year the tracker still keeps, this year and the five before it, the later
  year first, as a parcel tracked now is a recent one. It asks the next reading only when the
  tracker has no shipment for the first.
- An AliExpress guide is asked as `ALI-OLVA` and its digits, which the tracker reads as a client
  guide. Written without `ALI-`, it is asked as the shipment's external code.
- An unknown number is the page with no shipment and the message "No se encontró información
  para el criterio proporcionado.", which the page shows as not found. Any other message is
  inconclusive. A 404 or a redirect is a moved page.
- SiteGround hosts the site and answers 403 to a User-Agent of a crawler's shape,
  `Mozilla/5.0 (compatible; …)`, the package's default among them. The adapter sends a desktop
  browser's User-Agent. A 403, or a redirect to SiteGround's captcha, is a browser check.
- The page must echo the number and read it the way it was asked, and the shipment must name
  the number asked or, for a guide, its external code.
- Recognition makes the same requests.

## Notes

- Each scan's date and time are a wall clock with no zone. Delivery rounds are scanned from the
  morning on, which as UTC would be before dawn in Peru, but merchants' systems book shipments
  in the small hours, and the reply marks the shipment's own status time, the same wall clock,
  as UTC. The clocks stay `local_time`. A scan at midnight exactly keeps only its day.
- `REPARTO` files every move after the booking under the title "En camino a tu domicilio". Its
  wording stages it: a store took the parcel in, it travels to a town or a store, it waits at a
  store for collection, or it is out for delivery. An `INCIDENCIA` is a failed attempt when its
  wording says the delivery failed, and a problem otherwise.
- The scans come in groups by milestone, out of order, and a delivery run can be listed in two
  of them. The adapter sorts them by clock and keeps each once.
- The shipment's `currentStatus` can trail its scans, for instance staying at the store's
  intake after the delivery, so the stage comes from the newest scan the map stages.
- A guide's shipment names Olva's own number, which the adapter returns as the canonical
  number.
- The recipient's name, district, masked phone and ID document, the shipment's contents, its
  progress rail and its origin and destination in the reply are not kept.

## Limitations

- No delivery estimate, no instants and no proof of delivery.
- The tracker also takes credit customers' service orders, on another page, and other
  carriers' numbers for shipments Olva delivers. The adapter asks only Olva's own numbers and
  AliExpress guides.
- A number without its hyphen whose two readings are both shipments gets the later year's.

## Numbers

Olva's tracking number pairs a serial with the two-digit year it was issued. Its help pages
print it as eight digits, a hyphen and the year, and its tracker's example puts the year first,
a hyphen and seven digits. No rule claims these: detection compares numbers with spaces and
hyphens stripped, and they are then plain digit runs other carriers print too. The tracker's
example of an AliExpress shipment is `ALI-OLVA` and eight digits; `olva-courier-3` claims it,
written with or without the hyphen. The samples and their sources are in
[`numbers.json`](numbers.json).

## Links

The tracker's search form sends the number as `q` to `tracking.olvacourier.com`, so that
address with `?q=` opens one shipment. The page needs Olva's own number with its hyphen.

## Testing

`npm run test:carriers:live -- carriers/olva-courier`, with `OLVA_COURIER_TRACKING_NUMBER` and
optionally `OLVA_COURIER_UNKNOWN_NUMBER` set outside the repository.
