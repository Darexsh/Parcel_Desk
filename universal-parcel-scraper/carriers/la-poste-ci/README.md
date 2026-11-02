# La Poste de Côte d'Ivoire

La Poste de Côte d'Ivoire parcels use enabled universal providers. There is no dedicated
adapter.

## Numbers

La Poste de Côte d'Ivoire's letters, parcels and EMS items carry UPU S10 numbers ending in
`CI`. Generic postal detection handles these numbers, so no rule for La Poste de Côte d'Ivoire
claims them. Inbound items keep the number of the post that sent them.

## Links

The tracker at `laposte.ci.post/tracking-colis` posts the reference in a form, and the site
links to no page for one item.

## Why there is no adapter

The tracker, "Suivi Envoi national", looks up domestic deliveries by a reference of four digits, a
hyphen and fifteen digits, the shape its form gives as an example. It answers S10 numbers, the
examples it gave before included, with its notice for an unknown reference, "Aucune livraison
trouvée". The S10 lookup on another host that the form used before does not answer connections
from Europe. No domestic reference is public, so what the tracker shows for a delivery it holds is
unknown. For mail from or to abroad the site links UPU's Global Track & Trace and the EMS
Cooperative's tracker, which the [UPU provider](../../providers/upu/README.md) and the
[EMS](../ems/README.md) carrier read. So La Poste de Côte d'Ivoire stays on universal providers.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
