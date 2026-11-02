# Text CAPTCHA model

`captcha.onnx` is the unmodified `common_old.onnx` from
[sml2h3/ddddocr](https://github.com/sml2h3/ddddocr/tree/c40f56f95412e10bcb9bd0bd24411e92f896d238).
The upstream MIT license is retained in [LICENSE](LICENSE).

The worker accepts each carrier's declared image geometry and format, resizes it to the model's
grayscale input and decodes its CTC output. `characters.json` retains the blank,
Latin-letter and digit labels at their original indices from `CHARSET_OLD`.
An output outside that alphabet is unreadable, rather than forced to a Latin character.
This model does not solve reCAPTCHA or locate ordered Chinese-character clicks.

ECMS uses a separate `arithmetic-characters.json` alphabet from the same upstream
indices: digits, plus and minus. Its profile crops off the fixed equals-sign
column before inference. Other profiles retain their own geometry and alphabet.
