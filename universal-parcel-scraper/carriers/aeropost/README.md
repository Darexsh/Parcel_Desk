# Aeropost

Aeropost parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Aeropost carries parcels from Miami to Central America, the Caribbean and South America.
Archived answers from its own tracking API show Costa Rican shipments numbered `CR` and ten
digits. `aeropost-1` suggests Aeropost for that layout at low confidence, because Aramex
Australia, Aramex New Zealand and Colis Privé accept any two letters and ten digits or any
twelve characters. The tracking page asks courier customers for a number starting `MIA`, shown
only as a mask, so no rule claims it. Temu orders delivered by Aeropost keep Temu's own number.

## Links

Aeropost's tracking page builds `aeropost.com/{language}/tracking/{number}`, also under a
gateway code such as `aeropost.com/SJO/es/tracking/{number}`. Its older shipment tracker opened
one parcel at `tracking.aeropost.com/{number}`. The library reads the number from each form.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
