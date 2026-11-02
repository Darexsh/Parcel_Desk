# Correo Argentino

Tracks Correo Argentino items, its own and those other posts send to Argentina, through the
lookup behind Correo Argentino's tracking forms.

## How it works

The tracking forms on correoargentino.com.ar post a number to
`sites/all/modules/custom/ca_forms/api/wsFacade.php`, which answers with an HTML fragment the page
inserts. One lookup is one form-encoded POST of the fields the page's script sends:

- an item numbered in Argentina goes to the national form, `action=ondnc`, as its service letters,
  nine digits and country in `producto`, `id` and `pais`;
- an item from abroad goes whole to the international form, `action=oidn`, in `id`.

No account, key, cookie, CAPTCHA token or browser is needed; the forms' CAPTCHA is switched off in
the page's script. A lookup that fails to reach the site is tried once more within the budget.

The reply must name the whole requested number, and each history needs its known columns and the
movement count printed under it. "No se encontraron resultados", alone, is the only missing item.
The form's other notice and the PHP warnings the lookup prints when its backend fails are
inconclusive. The site's firewall page, even with HTTP 200, and HTTP 403 are challenges; other HTTP
errors and malformed replies keep their own failure kinds. Recognition uses the same lookup.

## Numbers

The tracker follows S10 item codes. The adapter takes them with a valid check digit from any
country and refuses anything else without a request. A code ending `AR` is asked on the national
form; the international form does not find it, nor does the national form a foreign code. Generic
postal detection keeps S10 codes, and a code ending `AR` only suggests Correo Argentino, which
recognition asks first. Mail a provider reports as bound for Argentina is looked up here by its S10
code.

The site also has forms for e-commerce parcels and Mercado Libre shipments, which take other
layouts. No live number of those was found, so the adapter does not take them.

## Notes

The international form's reply holds the item's IPS events, as the origin post and Correo
Argentino recorded them, and, once the item reached Correo Argentino's network, its national
history under the domestic number it got there. The adapter joins both into one history ordered by
wall clock.

The national history's scans are read on Buenos Aires' clock: its delivery rounds and branch scans
fall in Argentina's working hours. The IPS rows carry no zone. For the same scan, Argentina's own
IPS rows differ from the national history by none or three hours, so they and the foreign posts'
rows stay local times. The delivery time of an item from abroad comes from the national history.

The national history splits a delivery visit into "INTENTO DE ENTREGA" and a status column saying
how it went. The adapter joins them, as in "INTENTO DE ENTREGA: ENTREGADO", because the event alone
reads as a failed attempt. IPS events keep their English names and leg. The map reads both; wording
it does not know goes to the shared rules. After "PLAZO VENCIDO NO RECLAMO", nobody collected the
item in time and it goes back to its sender, so its later movements are its return.

The AFIP customs box, the payment line, the import footnote, the IPS reason and action columns and
the domestic number of an item from abroad are not read.

## Limitations

The tracker has no estimated delivery date, service name, weight, recipient or proof of delivery,
and its clocks have no offsets. An item from abroad that has not reached Correo Argentino's
network has only local times.

## Links

The current forms post the number in the background, so no address opens one item. The former
tracker took a whole inbound number in the path of
`correoargentino.com.ar/seguimiento_envios/consultar/oidn/`; only that number is read from it.

## Live test

Set `CORREO_ARGENTINO_TRACKING_NUMBER` to a number ending `AR` outside the repository and run
`npm run test:carriers:live -- carriers/correo-argentino/adapter.live.test.ts`. Optionally set
`CORREO_ARGENTINO_INBOUND_NUMBER` to an item from abroad and `CORREO_ARGENTINO_UNKNOWN_NUMBER` to
check a number without history.
