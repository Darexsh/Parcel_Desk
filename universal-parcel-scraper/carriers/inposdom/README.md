# INPOSDOM

INPOSDOM parcels use enabled universal providers. There is no dedicated adapter.

The Instituto Postal Dominicano (INPOSDOM) is the national post of the Dominican Republic.

## Numbers

Its items carry UPU S10 numbers ending in DO, and items from abroad keep the sending post's
number. Generic postal detection handles both, so no carrier rule claims the layout: a rule
would name a post that recognition cannot ask.

## Links

INPOSDOM's tracker, Inposoft, takes the number in a form and has no address that opens one
item.

## Why there is no adapter

Inposoft answers a plain form post, but it only follows items that have arrived in the
Dominican Republic; INPOSDOM sends senders of outgoing items to the UPU's tracking. No reply
for a found item has been seen yet, and its not-found message also covers items not yet
arrived, so a parser could not tell the two apart.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
