# Seino Super Express

Seino Super Express parcels use enabled universal providers. There is no dedicated adapter.

Seino Super Express (セイノースーパーエクスプレス, SSX), formerly Seibu Unyu (西武運輸), is a Seino Holdings company
carrying express parcels and freight across Japan; it also delivers some inbound FedEx shipments. Seino
Transportation (西濃運輸) is a separate company and entry, with its own numbers and routes. Its site is
seino.co.jp/ssx.

## Numbers

Its slip numbers (伝票番号) are ten, thirteen or fifteen digits, which its tracker shows padded to fifteen. Seino
Transportation's tracker does not know the public example. Bare digits of these lengths are shared by many
carriers, Seino Transportation's ten among them, and no check digit is known, so there is no rule.

## Why there is no adapter

Its tracker answers an open GET without a cookie, session or CAPTCHA: `Main.jsp` on inquire.trc.ssx.seino.co.jp
with `uji.verbs=NAHS0010_find`, `uji.bean=com.seibu.bean.na.NAHS0010Bean` and the number in `strDenpyoNo1`. The
Shift_JIS page shows the receipt and the latest status with their branch, dated by month and day without a
year, and says when a number is not registered. It answers for about 65 days after shipping. No adapter has
been written for it yet.

## Links

The tracker's lookup address takes the number in `strDenpyoNo1`.

## Testing

Provider live-test inputs and commands are in the
[provider READMEs](../../providers/README.md).
