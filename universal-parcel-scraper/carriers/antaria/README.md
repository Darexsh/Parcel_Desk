# Antaria Services

Antaria Services parcels use enabled universal providers. There is no dedicated adapter.

Antaria Services (ANTARIA SERVICES SLU), based in Alcalá de Henares near Madrid, has delivered
documents and parcels across Spain and Portugal since 2005, with timed next-day services and
international shipping. Its site is antariaservices.es.

## Numbers

Its tracker takes the ten-digit albarán (delivery note number), and an archived lookup on it
shows one. Envialia's albaranes and many other carriers' numbers also have ten digits, so there
is no rule.

## Why there is no adapter

The tracker posts the albarán and opens the shipment's history in a popup page without a session
or CAPTCHA; some shipments open on an Envialia status page instead. The popup also shows the
recipient's name and address. One public number is known. An adapter can follow.

## Links

The popup page's address carries a client code that differs by branch, so no address opens a
shipment from its number alone.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
