# Azul Cargo Express

Azul Cargo Express parcels use enabled universal providers. There is no dedicated adapter.

## Numbers

Azul Cargo Express tracks a shipment by its AWB. Lookups archived from its tracker show
domestic AWBs of eleven digits. Eleven digits are shared by several carriers, so no rule
claims them.

## Links

The former tracker took the AWB as `n` on `Rastreio.aspx` with the AWB type. The current
site is `azullogistica.com.br`: its `/Rastreio` form posts one `Awbs[]` entry and
`BuscarRastreioPor: awb` to `/Rastreio/Rastrear`. Its public script sends no CAPTCHA
answer, but Akamai can refuse the POST with HTTP 403 after serving the form normally.
Browser execution can create Akamai sensor cookies while the same tracking POST remains
blocked. The newer `app.azullogistica.com.br` portal also links to this form. No address
opens one shipment today.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
