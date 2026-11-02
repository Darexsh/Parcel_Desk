# Peddler

Peddler's guest tracker covers its own urban-delivery labels and supported partner handoffs.
PDN Express is a separate carrier.

## Retrieval

`track.pdlr.nl/trackntrace/{number}` opens a form prefilled with the whole number. Its
Turnstile response and form fields belong to the same browser page. Submitting the native
form verifies that number before the client requests its tracking loader,
`/trackntrace/{number}?_data=routes/trackntrace.$inquiryNumber`.

The loader can return an inquiry number without dated activity or render a generic error
boundary. Neither an accepted verification nor an echoed number is a usable history.

## Limitations

There is no validated native history parser. The loader's explicit `Consignment not found`
reply differs from an identity-only record. Use enabled universal providers for retrieval;
public reference provenance remains in `numbers.json`.

## Testing

Provider live-test inputs and commands are in the [provider READMEs](../../providers/README.md).
