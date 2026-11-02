# FragilePAK

FragilePAK parcels use enabled universal providers. There is no dedicated adapter.

FragilePAK, run by Progistics Distribution of Hudson, Ohio, delivers big and bulky goods to homes
across the United States. Its site is fragilepak.com.

## Numbers

Archived links to its tracking page carry its numbers: 902, six digits and a check character, a
digit or X. The check character is the first nine digits taken as a number modulo 11, X standing
for 10. All the links come from one source, so the rule is low and does not check the character.
Bare runs of ten digits are shared with many carriers. Other links carry references with a U
between digits, which get no rule.

## Why there is no adapter

The tracking page, hosted by AgentGrid, needs the delivery ZIP code with the number, and no public
page shows a number with its delivery.

## Links

The tracking page fills in the number from its `id` parameter and asks for the ZIP code.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
