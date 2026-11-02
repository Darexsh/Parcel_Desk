# DHL eCommerce Türkiye

DHL eCommerce Türkiye, formerly MNG Kargo, is a Turkish domestic parcel network. Tracked
through its public tracking page.

## How it works

1. `direct`: `GET https://www.dhlecommerce.com.tr/gonderitakip` opens an anonymous session. Its
   form carries an ASP.NET Core anti-forgery token, paired with a cookie. The adapter posts the
   token and the number to `/gonderi-takip` with that cookie and reads the shipment page the
   site renders. It needs no account, key or browser.
2. `retry`: one more try in a new session when a request fails to reach the site or hangs. The
   first try gets half of the budget.

- The page draws a four-letter verification code that its own script checks before submitting
  the form. The code is never sent and the server does not ask for it; the site's own shipment
  links, such as a return's, post without it.
- An unknown number is redirected to the home page with `ResultStatus=True&CargoCompany=NotFound`:
  `NotFoundError`. Any other redirect, such as the error page a refused token leads to, is
  inconclusive. The firewall's rejection page is a `ChallengeError`.
- The page shows the shipment number in two layouts; both must be the requested number,
  otherwise `SchemaError`.
- Recognition makes the same lookup; only the not-found redirect is an unknown answer.

## Notes

- Each scan has a status label and a sentence, and stages come from the labels. A failed
  delivery's sentence is its reason, kept after the label ("Teslim Edilemedi: Devir") only when
  it holds nothing but text and branch names. "Devir" carries the parcel over to the next
  delivery day; a planned attempt with any other reason has no stage.
- A scan's place is the delivering branch it names, or the branch its sentence places the
  parcel in. A branch the parcel will leave from or is sent to is not its place.
- Scans carry a day without a time, kept as a local calendar day. The estimated delivery day is
  kept while the parcel is on its way and not earlier than its newest scan.
- "Gönderi İade Edildi" ends the shipment: the tracker follows the return under a return number
  of its own.
- Masked names, who received the parcel, branch addresses and phones, the order number,
  payment details, parcel count and size, and the origin province are not read.

## Numbers

The tracker asks for the twelve-digit shipment number. Twelve digits are shared with several
carriers and no checksum is known, so no rule claims them.

## Links

The old `mngkargo.com.tr/gonderitakip` page redirects to the tracker. The tracker is a form that
posts the number, so the link opens it empty.

## Limitations

- No scan times.
- A page listing more than one parcel history is inconclusive.
- The return number is not followed, and the tracker's order-number lookup is not used.

## Testing

`MNG_KARGO_TRACKING_NUMBER=... MNG_KARGO_UNKNOWN_NUMBER=... npm run test:carriers:live -- carriers/mng-kargo`
