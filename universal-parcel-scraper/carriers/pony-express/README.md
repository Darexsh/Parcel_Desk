# Pony Express

Pony Express parcels use enabled universal providers. There is no dedicated adapter.

Pony Express (Пони Экспресс) is a Russian express carrier with sister companies in other CIS
countries.

## Numbers

Its waybill numbers are ten digits printed with hyphens, two, four and four digits, and the
tracker asks for them as printed. Archived lookups also show nine digits with a check digit
after a hyphen, and e-commerce numbers: PN and eight digits, E and fifteen digits, and RU
with a date and a serial. Detection removes the hyphens, which leaves ten-digit runs that
many carriers print. The e-commerce layouts were seen only as archived lookups whose results
were not visible, so no rule claims any layout.

## Links

The tracker takes up to 25 numbers as `trace_ids` on its tracking page, and older links put the
number in the path after `track/`. Both are read as links.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
